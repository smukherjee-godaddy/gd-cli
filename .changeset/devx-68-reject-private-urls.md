---
"@godaddy/cli": patch
---

DEVX-68: Reject non-public URLs when initializing an application. URLs pointing at localhost, loopback addresses (127.0.0.1, ::1), private IP ranges (10/8, 172.16/12, 192.168/16), link-local addresses, or .local/.localhost hostnames are now rejected up front with a ValidationError that explains a publicly reachable HTTPS URL is required, instead of being accepted and later failing at delivery time with an opaque NetworkError. Public HTTPS URLs and valid hostnames continue to be accepted (behavior unchanged)
