# Local execution and project data

This application is for a trusted local workstation. `edit_scene` executes Blender Python supplied by an AI client with the current user's OS permissions. The tool description asks the AI not to run shell commands, use the network, or write external files, but **that text is guidance, not a Python sandbox**. Only connect AI clients and project material you trust, and review generated code before using it for sensitive work.

The web server binds to `127.0.0.1`. External MCP clients use a random local capability stored at `.studio/connector-secret` (or under `STUDIO_DATA_DIR`). The file is created with owner-only permissions where supported. Do not commit this file or expose the server over a public interface. The MCP adapter supports local stdio; it is not a remote hosted MCP server.

Images shown to an AI through `view_image`, and any user files you submit to that AI, may be processed by the AI provider according to that provider's terms. Blender projects, image originals, renders, and logs remain in the configured local data directory unless you explicitly export or share them.

For a vulnerability report, please open a GitHub issue that does not include secrets or private product assets, or contact the repository maintainer privately through GitHub.
