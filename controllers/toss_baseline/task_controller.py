"""Fixed toss baseline, tuned for an older, closer bin position."""

TOSS_SPEED = 0.38
RELEASE_AT = 0.80


def plan(scene):
    obj = scene["objectPos"]
    bin_y = scene["binCenter"][1]
    windup_x = 0.55
    throw_height = 0.24
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2]], "speed": 0.15},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], throw_height], "speed": 0.15},
        {"skill": "move_to_pose", "pos": [windup_x, bin_y, throw_height], "speed": 0.2},
        {
            "skill": "toss",
            "pos": [0.77, bin_y, throw_height],
            "speed": TOSS_SPEED,
            "releaseAt": RELEASE_AT,
        },
    ]
