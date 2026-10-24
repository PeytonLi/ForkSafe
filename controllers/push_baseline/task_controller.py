"""Baseline straight-push controller for the gap task."""


def straight_push(scene):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    x = cube[0]
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


def plan(scene):
    return straight_push(scene)
