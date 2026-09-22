---
sidebar_position: 9
title: "Object Inspector & Explain"
---

# Object Inspector & Explain

The Object Inspector is a slide-out panel that provides detailed field-level information about individual objects on the heap. Combined with the AI Explain feature, it gives you both raw data and intelligent analysis to quickly understand why an object exists and whether it poses a memory concern.

## Opening the Inspector

In the **Dominator Tree** tab, each Instance row displays a magnifying glass icon on the right side. Clicking this icon opens the Object Inspector as a slide-out panel on the right side of the webview. The panel overlays the existing content without navigating away from the tree, so you retain full context of where the object sits in the dominator hierarchy.

## What You See

The inspector panel is organized into several sections from top to bottom:

### Header

The panel header displays the **fully-qualified class name** of the inspected object (for example, `com.example.cache.LRUCache`). This immediately identifies the type you are examining.

### Size Summary

Directly below the header, two key metrics are shown:

- **Shallow size** -- the memory consumed by the object's own fields (in bytes, with a human-readable formatted value such as "48 B" or "2.1 KB").
- **Retained size** -- the total memory that would be freed if this object were garbage collected, including all objects it exclusively dominates.

### Field List

The body of the panel contains a table of the object's fields. Each row shows:

| Column | Description |
|--------|-------------|
| **Name** | The field name as declared in the Java class (e.g., `table`, `size`, `loadFactor`). Inherited fields appear after the object's own fields. |
| **Type** | The field type -- primitive types display as `int`, `long`, `boolean`, etc. Reference types display the class name of the referenced object. |
| **Value** | For primitive fields, the actual value is shown (e.g., `16`, `0.75`, `true`). For reference fields, the value shows the referenced object's class name along with its retained size. Reference values are rendered as **clickable links** that allow drill-down navigation. |

### Explain Button

At the bottom of the panel, an **"Explain this object"** button triggers the AI-powered analysis described in the [AI Explain](#ai-explain) section below.

## Navigating References

When a field holds a reference to another object, its value column displays a clickable link showing the target class name and retained size (for example, `HashMap$Node[] (4.2 MB)`). Clicking this link replaces the current inspector content with the inspector view for the referenced object.

This drill-down navigation lets you walk the object graph interactively. You can follow reference chains from a top-level dominator all the way down to the leaf objects that actually hold the data, understanding at each step which fields contribute to memory retention.

## AI Explain

The AI Explain feature uses a configured LLM provider to generate a natural-language analysis of the inspected object.

### How It Works

1. Click the **"Explain this object"** button at the bottom of the inspector panel.
2. The button text changes to **"Analyzing..."** and becomes disabled while the request is in progress.
3. A streaming response begins to appear below the button. Text arrives incrementally, so you can start reading the analysis before it finishes.
4. When streaming completes, the full response is rendered as **formatted Markdown**, including headings, bullet lists, and fenced code blocks with syntax highlighting.

### What the Explanation Includes

A typical AI explanation covers the following areas:

- **What the object is** -- a plain-language description of the object's purpose based on its class name, field structure, and values.
- **Why it is a concern** -- an assessment of whether the object's retained size is unusual or indicative of a problem, given its type and context.
- **Retention chain analysis** -- an explanation of how the object is being kept alive and which reference paths prevent it from being garbage collected.
- **Concrete fix** -- actionable advice with **before/after Java code examples** demonstrating how to resolve the issue (e.g., switching from a strong reference cache to a `WeakHashMap`, adding eviction policies, or breaking circular references).
- **Severity classification** -- a rating of how critical the issue is, helping you prioritize which objects to address first.

### Error Handling

If no API key is stored, clicking the "Explain this object" button displays an error message prompting you to run the secure key command. See the [Configuration](#configuration) section below.

## Explain in Leak Suspects

The AI Explain capability is not limited to the Object Inspector. On the **Leak Suspects** tab, each leak suspect card includes an **"Explain"** link. Clicking this link triggers the same AI-powered analysis, with the streaming response rendered inline within the leak suspect card.

This is particularly useful for triaging leak suspects quickly -- you can get an intelligent explanation of each suspect without leaving the Leak Suspects view or manually navigating to the object in the Dominator Tree.

## Configuration

The AI Explain feature requires a provider setting and, except for Ollama, a securely stored provider key:

| Setting | Description |
|---------|-------------|
| `heaplens.llm.provider` | The LLM provider to use for generating explanations (e.g., `anthropic`, `openai`). |

Select the provider under `heaplens.llm`, then run **HeapLens: Set LLM API Key** from the Command Palette. The key is encrypted with VS Code SecretStorage and is not placed in user or workspace settings. Without a stored key, the Explain buttons display an error rather than producing an analysis.
