# Provider protocol engine

`internal/protocol` is copied from ddcat-ai/open-ai-canvas (local review snapshot
`open-ai-canvas-review-20261101`). It remains governed by the accompanying
`LICENSE.yingce` (MIT). The expression evaluator, manifest validation, request and
response mappings, media-upload declarations, and upstream protocol tests are
the original implementation. Artifact tests requiring the unrelated payment or
platform installation have not been included.

`cmd/provider-engine` is the Chuangyi stdio host bridge. No HTTP listener is
started. The host application retains account authorization, outbound proxy,
private-media ownership, logs and task lifecycle. Only declarative provider
contributions and host protocol implementations are executable here; uploaded
plugin scripts, binaries, payment and application hooks are never executed.

Build on Windows: `go build -trimpath -ldflags "-s -w" -o bin/provider-engine-windows-amd64.exe ./cmd/provider-engine`.
The prebuilt binary is included so deployment computers do not need Go.
