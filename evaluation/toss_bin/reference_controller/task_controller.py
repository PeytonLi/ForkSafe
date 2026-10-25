"""Protected ballistic toss controller used for suite reachability."""

import math

GRAVITY = 9.81
WINDUP_X = 0.30
RELEASE_END_X = 0.85
LIFT_HEIGHT = 0.48
WINDUP_HEIGHT = 0.32
RELEASE_END_HEIGHT = 0.60
RELEASE_AT = 0.50
RELEASE_X_ESTIMATE = 0.43
RELEASE_HEIGHT_ESTIMATE = 0.41
TRACKING_COMPENSATION = 1.18
MAX_TOSS_SPEED = 2.0


def _range_for_speed(
    speed: float, horizontal_component: float, vertical_component: float, flight_height: float
) -> float:
    tracked_speed = speed / TRACKING_COMPENSATION
    vertical_speed = tracked_speed * vertical_component
    flight_time = (
        vertical_speed
        + math.sqrt(vertical_speed**2 + 2.0 * GRAVITY * flight_height)
    ) / GRAVITY
    return tracked_speed * horizontal_component * flight_time


def _speed_for_distance(
    distance: float, horizontal_component: float, vertical_component: float, flight_height: float
) -> float:
    low, high = 0.01, MAX_TOSS_SPEED
    for _ in range(36):
        mid = (low + high) / 2.0
        if _range_for_speed(mid, horizontal_component, vertical_component, flight_height) < distance:
            low = mid
        else:
            high = mid
    return high


def plan(scene):
    obj = scene["objectPos"]
    bin_center = scene["binCenter"]
    target_y = bin_center[1]
    direction = 1.0 if bin_center[0] >= (WINDUP_X + RELEASE_END_X) / 2.0 else -1.0
    windup_x = WINDUP_X if direction > 0 else RELEASE_END_X
    release_end_x = RELEASE_END_X if direction > 0 else WINDUP_X
    release_x = RELEASE_X_ESTIMATE if direction > 0 else (
        WINDUP_X + RELEASE_END_X - RELEASE_X_ESTIMATE
    )
    lateral_swing = math.copysign(min(abs(target_y), 0.1), target_y) if target_y else 0.0
    windup_y = target_y - lateral_swing
    release_y = windup_y + RELEASE_AT * lateral_swing
    path_dx = release_end_x - windup_x
    horizontal_path = math.hypot(path_dx, lateral_swing)
    path_length = math.hypot(horizontal_path, RELEASE_END_HEIGHT - WINDUP_HEIGHT)
    direction_x = path_dx / horizontal_path
    direction_y = lateral_swing / horizontal_path
    signed_distance = (
        (bin_center[0] - release_x) * direction_x
        + (bin_center[1] - release_y) * direction_y
    )
    horizontal_component = horizontal_path / path_length
    vertical_component = (RELEASE_END_HEIGHT - WINDUP_HEIGHT) / path_length
    flight_height = max(
        RELEASE_HEIGHT_ESTIMATE - scene["objectHalfSize"], 0.01
    )
    speed = _speed_for_distance(
        signed_distance, horizontal_component, vertical_component, flight_height
    )
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], obj[2]], "speed": 0.15},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [obj[0], obj[1], LIFT_HEIGHT], "speed": 0.12},
        {
            "skill": "move_to_pose",
            "pos": [windup_x, windup_y, WINDUP_HEIGHT],
            "speed": 0.12,
        },
        {"skill": "wait", "sec": 0.2},
        {
            "skill": "toss",
            "pos": [release_end_x, target_y, RELEASE_END_HEIGHT],
            "speed": speed,
            "releaseAt": RELEASE_AT,
        },
    ]
