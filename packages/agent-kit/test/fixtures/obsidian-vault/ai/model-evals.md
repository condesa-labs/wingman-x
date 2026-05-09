# Model Evals

Evaluation for AI systems should use realistic tasks, stable fixtures, and clear pass or fail rubrics. A model benchmark that only checks style can miss whether the assistant used the right data source. Good evals include adversarial examples, stale context, malformed inputs, and tool failures. The prompt should be treated as a hypothesis, while measured behavior is the artifact that matters.

When testing an LLM workflow, keep the dataset versioned, keep random seeds pinned where possible, and save the exact input and output. That makes regressions visible when a model, prompt, parser, or retrieval index changes.
