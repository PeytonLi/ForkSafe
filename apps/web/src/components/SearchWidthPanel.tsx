import { TASK_FAMILY_SPECS, isTaskFamily } from "@forksafe/contracts";
import { useLoad } from "../hooks";
import { Panel } from "./Panel";
import { countPassedCandidates, searchWidthReport, type SearchWidthGroup } from "./searchWidth";
import styles from "./SearchWidthPanel.module.css";

const COUNTED = "Counted from investigations this account can open.";
const ONE_WIDTH = "Only one search width is recorded, so this is not a comparison yet.";

function familyLabel(taskFamily: string): string {
  return isTaskFamily(taskFamily) ? TASK_FAMILY_SPECS[taskFamily].title : taskFamily;
}

export function SearchWidthPanel() {
  const state = useLoad(async (client) => {
    const listed = await client.listInvestigations();
    const open = listed.filter((item) => item.state !== "restricted");
    const selected = open.slice(0, 6);
    const rows = await Promise.all(selected.map(async (item) => {
      const [workspace, findings] = await Promise.all([
        client.getWorkspace(item.id),
        client.listFindings(item.id),
      ]);
      return {
        id: workspace.investigation.id,
        title: workspace.investigation.title,
        taskFamily: workspace.investigation.baselineCase.taskFamily ?? "unspecified",
        requestedEnvironments: workspace.investigation.requestedEnvironments,
        findingCount: findings.length,
        candidateCount: workspace.candidates.length,
        passedCandidateCount: countPassedCandidates(workspace.candidates, workspace.evaluations),
      };
    }));
    return { groups: searchWidthReport(rows), truncated: open.length > selected.length };
  }, []);

  return (
    <Panel title="Search width" state={state} testId="search-width">
      {(report) => <SearchWidthBody report={report} />}
    </Panel>
  );
}

function SearchWidthBody({ report }: { report: { groups: SearchWidthGroup[]; truncated: boolean } }) {
  const widths = new Set(report.groups.map((group) => group.requestedEnvironments));
  return (
    <div>
      <p className={styles.note}>{COUNTED}</p>
      {report.truncated && <p className={styles.note}>Showing the first 6 investigations this account can open.</p>}
      {widths.size < 2 && <p>{ONE_WIDTH}</p>}
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Environments</th>
              <th scope="col">Investigations</th>
              <th scope="col">Findings</th>
              <th scope="col">Candidates</th>
              <th scope="col">All required passed</th>
            </tr>
          </thead>
          <tbody>
            {report.groups.map((group) => (
              <tr key={`${group.taskFamily}|${group.requestedEnvironments}`}>
                <td>{familyLabel(group.taskFamily)}</td>
                <td>{group.requestedEnvironments}</td>
                <td>{group.investigationCount}</td>
                <td>{group.findingCount}</td>
                <td>{group.candidateCount}</td>
                <td>{group.passedCandidateCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
