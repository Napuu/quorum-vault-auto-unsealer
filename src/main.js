const fs = require('fs/promises');
const axios = require('axios');
const https = require('https');

// --- Configuration ---
// Read configuration from environment variables
const config = {
    primaryVaultAddr: process.env.PRIMARY_VAULT_ADDR || 'https://vault.vault.svc.cluster.local:8200',
    jwtTokenPath: process.env.JWT_TOKEN_PATH || '/var/run/secrets/vault/token',
    k8sAuthRole: process.env.K8S_AUTH_ROLE || 'auto-unsealer',
    vaultNamespace: process.env.VAULT_NAMESPACE || 'vault',
    unsealKeysPath: process.env.UNSEAL_KEYS_PATH || 'kv/data/internal/config/unseal-keys',
    // Comma-separated list of target Vault addresses
    targetVaultAddrs: (process.env.TARGET_VAULT_ADDRS || '').split(',').filter(addr => addr),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 30000,
    // For testing purposes, allows self-signed certificates
    insecureTls: process.env.INSECURE_TLS === 'true',
};

// --- HTTP Client Setup ---
// Create a reusable Axios instance
const httpsAgent = new https.Agent({
    // Reject unauthorized TLS certificates unless INSECURE_TLS is true
    rejectUnauthorized: !config.insecureTls,
});

const apiClient = axios.create({
    httpsAgent,
});

// --- Main Logic ---

/**
 * Logs in to the primary Vault using K8s auth and returns a client token.
 * @returns {Promise<string>} The Vault client token.
 */
async function getPrimaryVaultToken() {
    console.log('Attempting to log in to primary Vault...');
    try {
        const jwt = await fs.readFile(config.jwtTokenPath, 'utf-8');
        const response = await apiClient.post(
            `${config.primaryVaultAddr}/v1/auth/kubernetes/login`,
            {
                jwt: jwt,
                role: config.k8sAuthRole,
            }
        );
        const token = response.data.auth.client_token;
        if (!token) {
            throw new Error('Client token not found in login response.');
        }
        console.log('Successfully logged in to primary Vault.');
        return token;
    } catch (error) {
        console.error('Error getting primary Vault token:', error.message);
        throw error;
    }
}

/**
 * Fetches the unseal keys from the primary Vault's KV store.
 * @returns {Promise<string[]>} An array of unseal keys.
 */
async function getUnsealKeys() {
    try {
        const token = await getPrimaryVaultToken();
        console.log('Fetching unseal keys...');
        const response = await apiClient.get(
            `${config.primaryVaultAddr}/v1/${config.unsealKeysPath}`, {
                headers: {
                    'X-Vault-Token': token,
                    'X-Vault-Namespace': config.vaultNamespace,
                },
            }
        );

        // Keys are nested under `data.data` for KV v2
        const keys = response.data.data.data;
        if (!keys || Object.values(keys).length === 0) {
            throw new Error('No unseal keys found or path is incorrect.');
        }
        console.log(`Successfully fetched ${Object.values(keys).length} unseal keys.`);
        // Return only the values of the keys (key1, key2, etc.)
        return Object.values(keys);
    } catch (error) {
        console.error('Error fetching unseal keys:', error.message);
        throw error; // Propagate the error to stop the unseal attempt
    }
}

/**
 * Checks a single Vault node's status and unseals it if necessary.
 * @param {string} targetAddr - The address of the target Vault node.
 */
async function checkAndUnseal(targetAddr) {
    try {
        console.log(`Checking seal status for ${targetAddr}...`);
        const statusRes = await apiClient.get(`${targetAddr}/v1/sys/seal-status`);

        if (statusRes.data.sealed) {
            console.log(`❌ Vault at ${targetAddr} is SEALED. Starting unseal process.`);
            
            const unsealKeys = await getUnsealKeys();
            // We only need as many keys as the threshold requires
            const keysToUse = unsealKeys.slice(0, statusRes.data.t || 3);

            for (const key of keysToUse) {
                console.log(`Submitting unseal key to ${targetAddr}...`);
                const unsealRes = await apiClient.put(`${targetAddr}/v1/sys/unseal`, { key });

                if (!unsealRes.data.sealed) {
                    console.log(`✅ Vault at ${targetAddr} is now UNSEALED.`);
                    break; // Exit loop once unsealed
                } else {
                    const progress = unsealRes.data.progress;
                    const threshold = unsealRes.data.t;
                    console.log(`Unseal progress for ${targetAddr}: ${progress}/${threshold}`);
                }
            }
        } else {
            console.log(`✔️ Vault at ${targetAddr} is already unsealed.`);
        }
    } catch (error) {
        // Handle cases where the target Vault node is unreachable
        if (error.response) {
            console.error(`Error checking/unsealing ${targetAddr}: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            console.error(`Error connecting to ${targetAddr}:`, error.message);
        }
    }
}

/**
 * The main polling function that iterates through all target nodes.
 */
function pollVaultNodes() {
    console.log('--- Starting new polling cycle ---');
    if (config.targetVaultAddrs.length === 0) {
        console.warn('No target Vault addresses configured. Set TARGET_VAULT_ADDRS.');
        return;
    }

    // Process each target node
    config.targetVaultAddrs.forEach(checkAndUnseal);
}

// --- Service Start ---
function main() {
    console.log('🚀 Vault Auto-Unsealer service starting...');
    console.log(`Polling interval: ${config.pollIntervalMs / 1000} seconds`);
    if (config.insecureTls) {
        console.warn('⚠️ INSECURE_TLS is enabled. TLS certificate validation is disabled.');
    }
    
    // Start the polling loop
    pollVaultNodes(); // Run once immediately
    setInterval(pollVaultNodes, config.pollIntervalMs);
}

main();