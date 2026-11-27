# Secret scrubber, blind set

secrets caught 581/604 = 96.2% (95% interval 94.4-97.4%)
harmless changed 6/498 = 1.2% (95% interval 0.6-2.6%)

| Writer | Caught | Harmless changed |
|---|---:|---:|
| opus | 294/308 | 2/250 |
| sonnet | 287/296 | 4/248 |

| Theme | Caught | Harmless changed |
|---|---:|---:|
| deploying web services to cloud providers (AWS, GCP, Azure, Fly, Vercel, Hetzner) | 62/62 | 1/50 |
| CI/CD pipelines and package publishing (GitHub Actions, GitLab CI, npm, PyPI, Docker registries) | 62/62 | 0/50 |
| databases and queues (Postgres, MySQL, MongoDB, Redis, RabbitMQ, Kafka connection strings and configs) | 48/58 | 1/50 |
| payments, mail and messaging APIs (Stripe, PayPal, SendGrid, Mailgun, Twilio, Slack, Discord, Telegram bots) | 55/60 | 0/50 |
| AI and data tools (OpenAI, Anthropic, Hugging Face, Replicate, Pinecone, Jupyter notebooks, Colab) | 57/58 | 0/50 |
| home and personal admin (router and wifi setup, NAS, smart home hubs, a family password note, bank or tax portal logins) | 62/66 | 0/49 |
| mobile and desktop app development (Firebase, Apple and Google developer accounts, signing keys, keystores) | 58/59 | 0/50 |
| servers and SSH (private keys, sudo passwords, VPN and WireGuard configs, Kubernetes secrets and kubeconfigs) | 56/58 | 2/49 |
| everyday mail and chat between colleagues sharing credentials badly (pasted into Slack, email, a ticket) | 59/59 | 1/50 |
| a coding agent session: the user pastes logs, stack traces and config files while debugging | 62/62 | 1/50 |
