# Topic: AI developer tooling

Illustrative library entry. Replace the body with your own takes on
this topic.

## Stance

- Prompt reliability beats model benchmark scores for real production
  workloads.
- Tool use + structured output is where agents actually earn their keep.
- Evaluating an agent only on its final answer misses 80 % of the
  regressions — eval the intermediate steps.

## Recurring references

- Anthropic, *Building effective agents* (2024).
- Simon Willison's series on structured output.
- The "eval harness" framing from several recent LangChain posts.

## Sample reply shapes

- *Counter to "model X > model Y" hype:* "Agreed that raw benchmarks
  favour X, but in my runs Y's tool-calling reliability is noticeably
  higher — that matters more for pipelines."
- *Pro-eval reminder:* "If your agent regresses silently the problem
  isn't the model, it's the missing per-step eval."

## Phrases to avoid

- "Just use GPT-4" — reductive and may age poorly.
- "Agents are solved" — they are not.
