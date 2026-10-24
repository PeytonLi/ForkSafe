"""Protected ballistic toss controller used for suite reachability."""

import math

GRAVITY = 9.81
WINDUP_X = 0.55
RELEASE_X = 0.85
RELEASE_AT = 0.90
RELEASE_HEIGHT = 0.48
TRACKING_COMPENSATION = 1.18


def plan(scene):
    obj = scene["objectPos"]
    bin_center = scene["binCenter"]
    target_y = bin_center[1]
    flight_height = RELEASE_HEIGHT - scene["objectHalfSize"] - 0.015
    flight_time = math.sqrt(2.0 * flight_height / GRAVITY)
    release_x = WINDUP_X + (RELEASE_X - WINDUP_X) * RELEASE_AT
    distance = math.hypot(bin_center[0] - release_x, target_y - bin_center[1])
    speed = max(0.55, distance / flight_time * TRACKING_COMPENSATION)
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2]], "speed": 0.15},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], RELEASE_HEIGHT], "speed": 0.12},
        {
            "skill": "move_to_pose",
            "pos": [WINDUP_X, target_y, RELEASE_HEIGHT],
            "speed": 0.12,
        },
        {
            "skill": "toss",
            "pos": [RELEASE_X, target_y, RELEASE_HEIGHT],
            "speed": speed,
            "releaseAt": RELEASE_AT,
        },
    ]
