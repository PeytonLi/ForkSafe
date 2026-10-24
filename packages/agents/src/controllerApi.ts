export function controllerApiDoc(taskFamily?: string): string {
  if (taskFamily === "toss_into_bin") {
    return [
      "Task family: toss_into_bin.",
      "Scene keys: taskFamily, objectPos [x,y,z], binCenter [x,y], binHalfExtents [hx,hy] (outer half-extents), binWallHeight, binWallHalfThickness, objectHalfSize, objectMass.",
      "Skills: move_to_pose {skill,pos:[x,y,z],speed?} uses linear constant-speed interpolation, workspace x=[0.2,0.85], y=[-0.4,0.4], z=[0,0.6], speed in (0,0.5] m/s after speedScale; open_gripper; close_gripper; wait {sec}; toss {skill:'toss',pos:[x,y,z],speed,releaseAt?}.",
      "Toss follows the move_to_pose path and continues through the endpoint. Its speed is in (0,2.0] m/s after speedScale. releaseAt is a fraction in (0,1], default 0.7; when attached, the object detaches at that path progress and inherits physical hand velocity. Aim at the bin center and account for ballistic flight from release height.",
      "Failure kinds: forbidden_contact, joint_limit, command_limit, nonfinite_command, stalled, timeout, engine_error, missing_artifact, invalid_run, dropped_early, bounced_out, missed_bin_short, missed_bin_long.",
      "Success: the detached object is inside the bin's inner xy footprint, below the wall top, and moves slower than 0.01 m/s continuously for 0.5 s.",
    ].join("\n");
  }
  if (taskFamily === "push_through_gap") {
    return "Task family: push_through_gap. Scene keys include cubePos, targetPos, gapCenter, gapWidth, wallHeight, and wallHalfThickness. Skills: move_to_pose, push, open_gripper, close_gripper, and wait. Avoid the gap walls and finish with the cube at targetPos.";
  }
  return "Task family: divider_pick_place. Scene keys include cubePos, targetPos, dividerCenter, dividerHeight, dividerHalfLength, and dividerHalfThickness. Skills: move_to_pose, open_gripper, close_gripper, and wait. Avoid the divider and place the cube at targetPos.";
}
