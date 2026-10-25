import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportFailurePanel } from "./ImportFailurePanel";
import { readImportedControllerFile, readImportedSceneFile } from "./importFailure";

const scene = {
  title: "Clip on the tall divider",
  taskFamily: "divider_pick_place",
  seed: 12,
  sceneOverrides: { dividerHeight: 0.15 },
};

function fileFrom(name: string, contents: string): File {
  return new File([contents], name);
}

describe("readImportedSceneFile", () => {
  it("rejects a file that is not JSON", async () => {
    const result = await readImportedSceneFile(fileFrom("scene.json", "{"));
    expect(result).toEqual({ ok: false, reason: "Scene file is not valid JSON." });
  });

  it("reads a scene JSON file", async () => {
    const result = await readImportedSceneFile(fileFrom("scene.json", JSON.stringify(scene)));
    expect(result).toEqual({ ok: true, value: scene });
  });
});

describe("readImportedControllerFile", () => {
  it("refuses a controller whose name does not end in .py", async () => {
    const result = await readImportedControllerFile(fileFrom("task_controller.txt", "def plan(scene):\n    return []\n"));
    expect(result).toEqual({ ok: false, reason: "Controller file must end with .py." });
  });

  it("accepts a .py controller", async () => {
    const source = "def plan(scene):\n    return []\n";
    const result = await readImportedControllerFile(fileFrom("task_controller.py", source));
    expect(result).toEqual({ ok: true, source });
  });
});

describe("ImportFailurePanel", () => {
  it("renders two file inputs and the use-files button", () => {
    const html = renderToStaticMarkup(createElement(ImportFailurePanel, {
      onImport: () => {},
      onClear: () => {},
      active: false,
    }));
    expect(html).toContain('data-testid="import-failure"');
    expect(html.match(/type="file"/g)).toHaveLength(2);
    expect(html).toContain("Use these files");
  });
});
