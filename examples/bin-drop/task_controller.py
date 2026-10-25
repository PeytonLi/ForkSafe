"""Failing bin drop: the arm carries the cube past the opening and lets go."""


def plan(scene):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    # 18 cm to the side of the bin center. The opening is only 12 cm wide.
    miss = [target[0], target[1] + 0.18, cube[2] + 0.16]
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2]], "speed": 0.2},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2] + 0.16], "speed": 0.2},
        {"skill": "move_to_pose", "pos": miss, "speed": 0.2},
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [miss[0], miss[1], miss[2] + 0.08], "speed": 0.2},
    ]
