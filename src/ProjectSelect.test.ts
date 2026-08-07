import { describe, it, expect } from "vitest";
import { groupProjectsByTeam } from "./ProjectSelect";
import type { LinearProject } from "./linear";

function makeProject(id: string, name: string, teams: Array<[string, string]>): LinearProject {
  return {
    id,
    name,
    teams: { nodes: teams.map(([tid, tname]) => ({ id: tid, name: tname, key: tname.slice(0, 3).toUpperCase() })) },
    hasIssues: true,
  };
}

describe("groupProjectsByTeam", () => {
  it("groups projects under their team, both levels sorted alphabetically", () => {
    const groups = groupProjectsByTeam([
      makeProject("p1", "Zeta", [["t2", "Pricing"]]),
      makeProject("p2", "Alpha", [["t2", "Pricing"]]),
      makeProject("p3", "Beta", [["t1", "Financials"]]),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Financials", "Pricing"]);
    expect(groups[1].projects.map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("lists a multi-team project under each of its teams", () => {
    const groups = groupProjectsByTeam([makeProject("p1", "Shared", [["t1", "Alpha"], ["t2", "Beta"]])]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.projects[0].id === "p1")).toBe(true);
  });

  it("keeps team-less projects reachable in a trailing bucket", () => {
    const groups = groupProjectsByTeam([
      makeProject("p1", "Orphan", []),
      makeProject("p2", "Owned", [["t1", "Zulu"]]),
    ]);
    // "No team" sorts after "Zulu" despite the alphabetical ordering of real teams.
    expect(groups.map((g) => g.name)).toEqual(["Zulu", "No team"]);
    expect(groups[1].projects.map((p) => p.name)).toEqual(["Orphan"]);
  });
});
