"""Baseline pick-and-place plan with intentionally low clearance."""

CARRY_HEIGHT = 0.06


def approach_waypoints(scene):
    cube = scene["cubePos"]
    return [
        [cube[0], cube[1], cube[2] + 0.12],
        [cube[0], cube[1], cube[2]],
    ]


def grasp_sequence():
    return [{"skill": "close_gripper"}]


def carry_waypoints(scene):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    return [
        [cube[0], cube[1], CARRY_HEIGHT],
        [target[0], target[1], CARRY_HEIGHT],
    ]


def place_sequence(scene):
    target = scene["targetPos"]
    return [
        {"skill": "move_to_pose", "pos": target, "speed": 0.2},
        {"skill": "open_gripper"},
    ]


def retreat_waypoints(scene):
    target = scene["targetPos"]
    return [[target[0], target[1], target[2] + 0.12]]


def plan(scene):
    sequence = [
        {"skill": "open_gripper"},
        *(
            {"skill": "move_to_pose", "pos": point, "speed": 0.2}
            for point in approach_waypoints(scene)
        ),
        *grasp_sequence(),
        *(
            {"skill": "move_to_pose", "pos": point, "speed": 0.15}
            for point in carry_waypoints(scene)
        ),
        *place_sequence(scene),
        *(
            {"skill": "move_to_pose", "pos": point, "speed": 0.2}
            for point in retreat_waypoints(scene)
        ),
    ]
    return list(sequence)
