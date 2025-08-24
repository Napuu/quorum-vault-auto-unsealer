# Quorum Vault Auto-Unsealer

This is an experimental service that automatically unseals sealed HashiCorp Vault nodes.

It runs as a sidecar or a separate deployment within a Kubernetes cluster. It authenticates to a primary, unsealed Vault instance using a Kubernetes Service Account to fetch the unseal keys, then applies them to sealed target nodes.

## How It Works

1.  **Polling:** The service periodically checks the `/v1/sys/seal-status` endpoint of each target Vault node.
2.  **Detection:** If a node reports itself as `sealed`, the service initiates the unseal process.
3.  **Authentication:** It authenticates to the primary Vault instance using its Kubernetes service account JWT.
4.  **Key Fetching:** It retrieves the unseal keys stored in the primary Vault's KV secrets engine.
5.  **Unsealing:** It submits the required number of unseal keys to the sealed node's `/v1/sys/unseal` endpoint until the node is unsealed.

## Configuration

The service is configured entirely through environment variables.

| Variable             | Description                                                                  | Default                                           |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `PRIMARY_VAULT_ADDR` | Address of the primary, unsealed Vault where keys are stored.                | `https://vault.vault.svc.cluster.local:8200`      |
| `TARGET_VAULT_ADDRS` | **Required.** A comma-separated list of target Vault nodes to monitor.         | `""`                                              |
| `POLL_INTERVAL_MS`   | How often (in milliseconds) to check the status of target nodes.             | `30000` (30 seconds)                              |
| `K8S_AUTH_ROLE`      | The Vault Kubernetes auth role to use for logging in.                        | `auto-unsealer`                                   |
| `VAULT_NAMESPACE`    | The Vault namespace where the unseal keys are stored.                        | `vault`                                           |
| `UNSEAL_KEYS_PATH`   | The path to the KV secret containing the unseal keys.                        | `kv/data/internal/config/unseal-keys`             |
| `JWT_TOKEN_PATH`     | The file system path to the Kubernetes service account JWT.                  | `/var/run/secrets/vault/token`                    |
| `INSECURE_TLS`       | Set to `true` to disable TLS certificate validation. **Use for testing only!** | `false`                                           |

### Example Configuration

An example deployment might use these environment variables:

```yaml
env:
- name: TARGET_VAULT_ADDRS
  value: "[https://vault-0.vault-internal:8200](https://vault-0.vault-internal:8200),[https://vault-1.vault-internal:8200](https://vault-1.vault-internal:8200),[https://vault-2.vault-internal:8200](https://vault-2.vault-internal:8200)"
- name: INSECURE_TLS
  value: "true" # If using self-signed certs
```

## Running the Service

Build the Docker image:

```sh
docker build -t vault-auto-unsealer:latest .
```

You can then run this image in a Kubernetes Deployment, ensuring the pod has a Service Account with the correct Vault policies attached to read the unseal keys.