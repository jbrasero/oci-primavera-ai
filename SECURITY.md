# Security policy

## Reporting a vulnerability

Do not publish credentials, tokens, customer data, exploit details, or sensitive
logs in a public issue. Report security findings privately to the repository
maintainers using a GitHub private vulnerability report or another agreed
private channel.

Include the affected version, reproduction steps, expected impact, and a
minimal redacted example. The maintainers will acknowledge the report and
coordinate remediation before public disclosure.

## Secrets

Real `.env` files, OCI configuration, Unifier credentials, API keys, tokens,
private keys, certificates, contracts, and customer exports must never be
committed. Use environment variables or a managed secret store.
