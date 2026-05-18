# koharu-core

Shared primitives for the v2 architecture refactor. Lands in Phase 1
of the rebuild — see [`docs/v2-arch.md`](../docs/v2-arch.md) on
`main` for the full design.

This crate intentionally has **no consumers yet**. It defines the
substrate that later phases will wire into:

| Module | What's here | Used by (future phase) |
|---|---|---|
| `id` | `PageId`, `NodeId`, `TmEntryId` newtypes | Everywhere |
| `blob` | `BlobId` (blake3-hashed), `BlobStore` (in-memory) | Phase 2 (serialization boundary) |
| `scene` | `Scene` → `Page` → `TextBlock` read model | Phase 3 (engine inputs) |
| `op` | `Op` enum (the unit of state change), `TextBlockPatch` | Phase 5 (`ProjectSession::apply`) |
| `hardware` | `HardwareReq`, `DetectedHardware`, `EngineCost` | Phase 3 (engine probe), Phase 4 (Engine Profile UI) |

## Why three-state `TextBlockPatch` fields

```rust
pub translation: Option<Option<String>>,
```

The outer `Option` distinguishes "this field is in the patch" from
"this field is unchanged". The inner `Option` distinguishes "set to
a string" from "explicitly clear". So we get three states from one
field:

| Wire shape | Outer | Inner | Meaning |
|---|---|---|---|
| key absent | `None` | — | leave field unchanged |
| `"translation": null` | `Some(None)` | — | explicitly clear field |
| `"translation": "..."` | `Some(Some(v))` | `Some(v)` | set field to `v` |

Serde's default `Option` deserializer collapses the first two cases
to outer `None`, losing the "explicit clear" signal. The
`double_option` helper in `op.rs` preserves the distinction.

## Testing

```bash
cargo test -p koharu-core
```

Includes proptest invariants for `Op` JSON round-trip. The full
apply/inverse property (apply ∘ undo ∘ apply = apply) lands in
Phase 5 alongside `ProjectSession::apply`.
