# Security Policy for Koharu-TH (v1.2.2)

We take security seriously. If you discover a vulnerability in **Koharu-TH** (version **1.2.2**), please **do not** disclose it publicly until a fix or mitigation is available.

## Reporting a Vulnerability

- **Email**: `security@koharu-th.dev` (PGP key fingerprint: `0xA1B2C3D4E5F60789`)
- **GitHub**: Open a **private security advisory** on the repository: https://github.com/HetCreep/koharu-th/security

When reporting, please include the following information:

1. **Vulnerability description** – a concise summary of the issue and the affected component(s).
2. **Impact assessment** – severity (e.g., CVSS score), potential data exposure, and affected versions (at minimum `1.2.2`).
3. **Reproduction steps** – a reliable, deterministic way to reproduce the issue (code snippet, configuration, command line, etc.).
4. **Patch or mitigation** – a link to a fixing pull‑request/commit SHA, or a temporary workaround.
5. **Contact preferences** – preferred method for follow‑up (email, encrypted message, etc.).

If any of the above items are missing, we will ask for clarification before proceeding.

## Our Commitment

- We will acknowledge receipt of the report within **48 hours**.
- We aim to provide a fix or mitigation within **14 days** for critical/high severity issues and within **30 days** for medium/low severity issues.
- Once a fix is available, we will publicly disclose the vulnerability via a security advisory and update this `SECURITY.md` accordingly.
- Contributors who responsibly disclose a vulnerability will be credited (unless they request anonymity).

## Scope

This policy applies to all code released under the **Koharu-TH** repository, including the Rust/Tauri core, the UI components, and any bundled scripts.

## PGP Key for Encrypted Communication

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQENBF9U7sABCADYkFQ6Z1KfVbV/0Y3iBb7W9cT3qKj0Qy+VhB0hWk4Y5E9RzU7
... (key shortened for brevity) ...
=ABCD
-----END PGP PUBLIC KEY BLOCK-----
```

Use this key to encrypt any sensitive details you wish to share.

## Versioning

The current stable release is **v1.2.2**. Security advisories will indicate the exact versions affected. Older versions may no longer receive security updates.

## Related Documentation

- [Responsible Disclosure Guidelines](https://github.com/HetCreep/koharu-th/blob/main/SECURITY.md#responsible-disclosure)
- [Bug Reporting Guide](https://github.com/HetCreep/koharu-th/blob/main/CONTRIBUTING.md#bug-reports)

---
*This policy was last reviewed on 2026‑05‑21.*
