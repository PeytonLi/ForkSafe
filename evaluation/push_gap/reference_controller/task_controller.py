"""Protected align-then-push controller used to construct the push-gap suite."""


def straight_push(scene, x):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    y = cube[1]
    target_y = target[1]
    return [
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [x, y - 0.06, 0.12]},
        {"skill": "move_to_pose", "pos": [x, y - 0.06, 0.03]},
        {
            "skill": "push",
            "pos": [x, target_y - 0.03, 0.03],
            "speed": 0.05,
        },
        {"skill": "move_to_pose", "pos": [x, target_y - 0.08, 0.03]},
        {"skill": "move_to_pose", "pos": [x, target_y - 0.08, 0.15]},
    ]


def push_through_gap(scene):
    cube = scene["cubePos"]
    gap_x = scene["gapCenter"][0]
    offset = gap_x - cube[0]
    if abs(offset) <= 0.005:
        return straight_push(scene, gap_x)

    direction = 1 if offset > 0 else -1
    # A 0.02 m lead avoids the empirically observed 0.03-0.04 m slide past the finger.
    lead_x = gap_x - direction * 0.02
    plan = [
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0] - 0.06, cube[1], 0.12]},
        {"skill": "move_to_pose", "pos": [cube[0] - 0.06, cube[1], 0.03]},
        {
            "skill": "push",
            "pos": [lead_x, cube[1], 0.03],
            "speed": 0.05,
        },
        {"skill": "move_to_pose", "pos": [gap_x, cube[1], 0.12]},
    ]
    plan.extend(straight_push(scene, gap_x)[1:])
    return plan


def plan(scene):
    return push_through_gap(scene)
