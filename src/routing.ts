export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, ""); // e.g. "/linear-planner"

export function getProjectIdFromUrl(): string | null {
  const path = window.location.pathname;
  const prefix = BASE_PATH + "/";
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length).replace(/\/$/, "");
    if (rest && rest !== "" && rest !== "callback") return rest;
  }
  return null;
}

export function navigateToProject(projectId: string | null) {
  const url = projectId ? `${BASE_PATH}/${projectId}/` : `${BASE_PATH}/`;
  window.history.pushState(null, "", url);
}
