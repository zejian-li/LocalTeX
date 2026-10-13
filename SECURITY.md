# Security model

LocalTeX is intended for one user's trusted projects on a local machine or through a private SSH tunnel. It listens on `127.0.0.1`. Host/Origin validation reduces browser-origin attacks; it is not authentication. A program/user that can reach the local endpoint can access the application's file operations. Do not publish it behind an unauthenticated reverse proxy, public forwarding URL or shared tunnel. There is no multi-user permission model.

The browser picker can browse the server user's filesystem. Project-path validation constrains application file operations inside the selected project, but **does not sandbox TeX, latexmk, bibliography tools or native programs**. These run with the server account's permissions; latexmk may execute project/user configuration. Open and compile only trusted projects, including imported ZIPs. Archive validation protects extraction paths and resources, not the behavior of the extracted source.

Project files remain on the server machine; LocalTeX has no cloud project-upload feature or telemetry. Browser extensions and writing assistants are separate software and may send source text elsewhere. Review Grammarly/extension permissions and privacy policies independently.

ZIP uploads are validated and limited. File saves use version checks, snapshots and atomic replacement; symlink checks and compiler lifecycle controls reduce risks. These safeguards do not provide isolation against another program deliberately changing the filesystem during an operation, untrusted native tools, disk failure or forced shutdown.

## Reporting

Report ordinary bugs with a minimal non-sensitive example. For vulnerabilities, use the repository's private vulnerability-reporting feature when enabled, or request a private contact channel from the maintainer before sharing exploit details. Do not post credentials, private source files, recovery snapshots or identifying paths publicly. The project is in beta and has no formal security-support SLA.
