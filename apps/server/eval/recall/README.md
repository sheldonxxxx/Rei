# Recall invocation eval

Measures whether a real model calls the memory and Knowledge tools when it should, and stays quiet when it should not.
`scenarios.json` lists each prompt, the state to seed, and the tools expected (`calls`) and forbidden (`notCalls`).

Run by hand through the deployed stack with a real provider (it needs a gateway), as the discovery scenarios are. For each
scenario record whether the expectations held. Report per group: should-call recall, no-call precision, and the first
tool called. Run the same scenarios before and after a wording change and record both in `RESULTS.md`.
