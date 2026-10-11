---
sidebar_position: 4
title: GC roots and Why alive
---

Roots are modeled reachability entry points: stack references, JNI handles, and VM-managed objects, for example. A recorded root path explains retention, not lifecycle intent.

## Root categories

The shared classifier handles Unknown, JNI Global, JNI Local, Java Frame, **Native Stack**, Sticky Class, **Thread Block**, Monitor Used, and Thread Object, plus supported extended interned-string, finalizing, debugger, reference-cleanup, VM-internal, JNI-monitor, and unreachable records. Coverage depends on variant/backend.

Native Stack and Thread Block are distinct categories. Display names/identifiers come from the classifier.

A synthetic **SuperRoot** joins graph entry points. It is not an application allocation; API/referrer views may expose synthetic nodes and ID 0. Do not treat them as editable application source.

## Follow a path

1. Choose Why alive for a real object.
2. Read root → target, inspect retaining fields/owners, and examine other incoming references.
3. Check whether the root, thread, or classloader is expected to stay alive.

Searches/paths are bounded. Empty/truncated output does not prove collectability; one path is not every route. Supported weak/soft/phantom referent edges are excluded by the implemented retaining policy, not a simulation of every collector decision.

Static fields retain through their class/classloader lifetime, not necessarily forever. Thread-local/JNI/classloader retention is a lead, not automatically a fault. See [Inspector](../tabs-guide/object-inspector.md) and [dominators](./dominator-tree.md).
