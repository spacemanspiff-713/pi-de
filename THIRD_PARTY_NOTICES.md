# Third-Party Notices and Design References

PiDE (Pi Development Environment) is distributed under the MIT License in [LICENSE](LICENSE).

## Runtime and libraries

This extension interoperates with the Pi coding agent and uses the JavaScript packages listed in `package.json`. Those projects retain their own copyright and license terms. Installed dependency license texts are available through their package metadata and distributions.

Notable runtime dependencies include:

- [Pi coding agent](https://pi.dev/) by the Pi project
- [markdown-it](https://github.com/markdown-it/markdown-it)
- [DOMPurify](https://github.com/cure53/DOMPurify)
- [highlight.js](https://github.com/highlightjs/highlight.js)

The optional MCP control-center integration consumes status and commands from [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter), which is installed and executed by Pi rather than bundled as this extension's MCP implementation.

## Design research

The following MIT-licensed projects were reviewed for product and architecture research:

- [`auchan/pi-on-code`](https://github.com/auchan/pi-on-code)
- [`JohnnyZ93/pi-agent-studio`](https://github.com/JohnnyZ93/pi-agent-studio)

The current codebase maintains its own RPC-sidecar, session index, Git checkpoint, MCP status bridge, and webview implementation. No source code from those projects is currently included verbatim. If future work adapts source code, the relevant copyright notice and MIT license attribution must be added to this file and retained with the adapted source.
