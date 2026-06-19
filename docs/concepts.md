# Concepts

Agent Scenario Loop exists because agent-driven app work rarely belongs to one tool.

One runner may edit code. Another may build the app. Another may drive Android. Another may drive iOS. Others may collect logs, screenshots, accessibility output, profiler traces, memory evidence, network captures, or summaries.

Execution is not the missing piece.

The missing piece is a durable place for scenarios, evidence, and comparisons to live after any one runner finishes. Agent Scenario Loop coordinates scenarios, runners, and evidence so a project keeps a stable record of what happened across tools and over time.

## What is an agent runner?

An agent runner is any tool that can carry out part of a software workflow on your behalf.

It might:

- click through an app
- run commands
- inspect a screen
- collect diagnostics
- drive a simulator or device
- collect logs, traces, or accessibility output

Examples include Codex, Argent, Agent Device, adb-based automation, accessibility tooling, Xcode instrumentation, Maestro, Detox, Appium, profilers, and custom internal runners. You do not need to know any specific one of these tools to understand Agent Scenario Loop. They are all ways to execute or observe part of a scenario.

## Why orchestration matters

The moment you want to mix multiple runners, reuse scenarios, compare results across runs, preserve evidence, or evaluate changes over time, things become fragmented quickly.

Every tool has its own way to define work, capture results, and preserve context.

Agent Scenario Loop provides the layer that coordinates the work:

1. Define an application scenario.
2. Attach the runners and instrumentation appropriate for that scenario.
3. Execute the scenario.
4. Collect evidence throughout the run.
5. Preserve the evidence as an artifact that humans and agents can inspect later.

## Vendor-neutral by design

Scenarios should outlive tooling choices.

The best runner for a task today may not be the best runner six months from now. Agent Scenario Loop treats runners as interchangeable components. You can swap runners, combine runners, introduce new runners, or compare runners without rewriting your scenario definitions.

The goal is not to build another agent runner. The goal is to provide a common orchestration and evidence layer that sits above them.

## Evidence is the output

Most testing systems produce a pass/fail result. Agent Scenario Loop produces evidence.

Evidence can include:

- logs
- traces
- memory measurements
- CPU measurements
- network activity
- accessibility results
- performance metrics
- custom signals

The scenario is not simply proving correctness. The scenario is generating evidence.

That evidence is preserved and becomes part of the project's understanding of itself. One run is useful. A hundred runs are more valuable because they let the project ask whether memory usage is improving, performance is degrading, regressions are appearing, or an optimization actually helped.

## Scenarios become assets

Most automation is tightly coupled to the tools that created it.

When the tooling changes, the automation is rewritten. When the agent changes, the workflow changes. When the framework changes, the evidence disappears.

Agent Scenario Loop is built around the opposite idea: scenarios are long-lived project assets.

A scenario captures something important about your application:

- how users consume content
- how creators upload media
- how campaigns are created
- how livestreams behave
- how conversations load

These concerns exist independently of whichever tools happen to execute them today.

As tooling evolves, your scenarios remain. As better agents emerge, your scenarios remain. As instrumentation improves, your scenarios remain.

Over time, a project accumulates a growing library of scenarios that describe its most important behaviors. Those scenarios become a stable lens through which change can be evaluated.

Not just whether something works today. Whether it is improving over time.

## The locus of control

Most teams unknowingly give the locus of control to the current tool.

Agent Scenario Loop moves it back into the application itself.

The feed is the thing that matters. The livestream is the thing that matters. The creator upload flow is the thing that matters. Agent Scenario Loop makes those concerns first-class citizens and lets tooling orbit around them instead of the other way around.

Every new scenario increases coverage. Every execution adds evidence. Every comparison adds historical context.

Eventually, the project develops a durable understanding of how critical parts of the application behave across releases, refactors, platform upgrades, and agent-driven changes.

The tooling may change. The runners may change. The agents may change. The scenarios remain the source of truth.

That is a different philosophy from frameworks that primarily evaluate agents. Agent Scenario Loop is built to evaluate the evolution of software.

## Boundary

Agent Scenario Loop is not a replacement for testing frameworks, automation tools, mobile drivers, profilers, or agent evaluation systems. Those tools can still execute or observe work.

The canonical boundary list lives in [What It Is Not](../README.md#what-it-is-not).

## Read next

- [Principles](principles.md) for the project doctrine
