# Imported failure laboratory

Status: phase 1. The two built-in scenes stay. A person can bring their own failing controller.

## Problem

ForkSafe can vary a divider scene and a gap scene, then run agents against the stock controller. That demonstrates the repair loop. It does not take a failure that already belongs to someone else. Their bug lives in their controller, not in the stock 6 cm carry or the straight push.

## Users

A robotics engineer who already has a Franka Panda scene ForkSafe can build, and a controller written as `plan(scene)`. They want ForkSafe to reproduce that failure, search for a repair, and prove the repair on scenes the agents did not use. A reviewer accepts or refuses one exact controller hash.

## What they bring

Two files. Neither file is optional when they choose import.

**Scene JSON**

```json
{
  "title": "Clip on the tall divider",
  "taskFamily": "divider_pick_place",
  "seed": 12,
  "sceneOverrides": { "dividerHeight": 0.15 }
}
```

`taskFamily` is `divider_pick_place`, `push_through_gap`, or `bin_drop`. `sceneOverrides` uses that task's slider keys and ranges. `seed` is a non-negative integer. Unknown keys, other task families, and other robots are refused. `bin_drop` is not one of the stock New simulation choices; it arrives through this upload.

**Controller Python**

One file named `task_controller.py`. It must define `plan(scene)` and return the skill list the simulator already runs (`move_to_pose`, `close_gripper`, `open_gripper`, `push`). Maximum size is 64 KiB. The source is rejected when it imports or calls `os`, `subprocess`, `socket`, `pathlib`, `importlib`, `sys`, `open`, `exec`, `eval`, `__import__`, or `compile`. The execution sandbox still loads the file the same way it loads an agent edit. This check is a gate, not a full sandbox.

## What they do

1. On New simulation, drop the scene JSON and `task_controller.py`, or keep the stock controller.
2. The sliders show the imported layout.
3. Choose how many environments to run, from 1 to 4 on this screen.
4. Press Start.

They do not launch each experiment. They do accept or refuse the candidate at the end. Acceptance stores the hash. It does not merge code or move a physical robot.

## What ForkSafe does

1. Validate both files before any sandbox starts. A bad file returns the reason and does not create an investigation.
2. Store the controller text by SHA-256 in `controllerSources`. The investigation's `controllerChoice` is `imported` and `controllerSha256` is that hash.
3. Run that exact controller once on that exact scene in a Daytona execution sandbox. The browser picture is not this run.
4. If the run succeeds, stop. Agents do not start. The replay stays available so the person can change the scene.
5. If the run fails for a physical reason, start the requested environments. Environment 1 gets the imported scene. Each later environment gets one slider step and a seed offset, using `sceneVariantFor`.
6. Agents may edit only their copy of the controller. They receive the public cases. They do not receive the withheld cases.
7. The evaluator scores an imported controller on the imported scene and on withheld variations. Withheld cases are `sceneVariantFor` indexes past the environments the agents were given. Stock divider and push investigations keep the suites they already use.
8. A reviewer approves or refuses one hash.

## Out of scope

A diff of the imported plan before Start. Arbitrary Python, ROS bags, URDF uploads, a new robot, learned policies, hardware deployment, and automatic merge.

## Acceptance

- A scene JSON file fills the task, seed, and sliders, or the screen shows the validation reason.
- A `task_controller.py` larger than 64 KiB, missing `plan`, or containing a forbidden call is refused before capture.
- Capture of an imported controller stores that source and runs it, including when an approved controller already exists for the task.
- A passing imported baseline does not start agents. This is the existing capture gate, not a new one.
- A failing imported baseline starts agents on `sceneVariantFor` scenes.
- Imported withheld case ids are disjoint from the scenes handed to those agents.
- Divider and push investigations that do not import a controller keep their current public and withheld suites.
- Fixture mode still refuses to pretend it ran physics.
