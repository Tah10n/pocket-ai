# Pocket AnyDoc fixture corpus

This directory contains only synthetic or public upstream test documents. It
must never contain user documents, production exports, credentials, or logs.

`upstream-anydoc-v0.1.7/` is the complete MIT-licensed fixture set from
`firecrawl/anydoc` commit
`4a45addbd607e8b59f0c263bca26aab228e10370`. Keeping the source fixture names
preserves their error/recovery expectations and makes upstream refreshes
auditable. The upstream license is retained at `../vendor/anydoc/LICENSE`.

`pocket-ai/` contains small Pocket AI-owned fixtures for multilingual prompt
boundaries and direct-text regressions. Generated Office and benchmark files
must use fixed synthetic metadata and are checked for local usernames and
absolute paths before they are accepted.

The corpus intentionally includes malformed and resource-exhaustion samples.
Never open or render these files with desktop office software; tests pass them
only to the bounded local parser.
