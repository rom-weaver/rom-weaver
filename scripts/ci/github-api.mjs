//
// GitHub REST plumbing shared by the pull request gates in
// `.github/workflows/pull-request.yml`.
//
// Both gates talk to the same three surfaces - a pull request, a commit status,
// and one marker comment - and both draw the same line between "the gate says
// no" (a red commit status, a green job) and "the gate itself broke" (a red
// job). Every unexpected response therefore throws instead of returning a falsy
// value a caller could mistake for a verdict.

export function createGitHubApi({ token, apiUrl, name }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": name,
  };

  async function api(path, { method = "GET", body, allow404 = false } = {}) {
    // The key has to be absent rather than undefined on a GET: fetch rejects
    // the combination, and oxlint flags it statically.
    const init = { method, headers: { ...headers, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await fetch(`${apiUrl}${path}`, init);

    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      throw new Error(
        `${name}: ${method} ${path} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  // The Link header is the only reliable page count; a short page is not proof
  // of the last one.
  async function paginate(path) {
    const items = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const response = await fetch(`${apiUrl}${next}`, { headers });
      if (!response.ok) {
        throw new Error(
          `${name}: GET ${next} failed with ${response.status}: ${await response.text()}`,
        );
      }
      items.push(...(await response.json()));
      const link = response.headers.get("link") ?? "";
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      next = match ? match[1].replace(apiUrl, "") : null;
    }
    return items;
  }

  return { api, paginate };
}

// Statuses are posted against an explicit head SHA rather than left to the
// check run the job produces: a run triggered by `issue_comment` attaches its
// check to the default branch, not to the pull request head, so only the status
// can be a required check that a comment is able to flip.
export function createStatusPoster({ api, repo, sha, context }) {
  return (state, description, targetUrl) =>
    api(`/repos/${repo}/statuses/${sha}`, {
      method: "POST",
      body: { state, context, description, target_url: targetUrl },
    });
}

// One comment per pull request per marker, edited in place, so a rebase or a
// retitle does not bury the thread under duplicates.
//
// The author is checked as well as the marker. The marker is an HTML comment,
// so it is invisible once rendered and nothing stops a contributor pasting one
// - and the token here is repo-scoped, so it would happily edit or delete
// somebody else's comment on the strength of a string they chose. Only a
// comment this workflow could have written is a candidate; anything else is
// left alone and a fresh one is posted alongside it.
export function createMarkerComment({ api, paginate, repo, prNumber, marker }) {
  const find = async () =>
    (await paginate(`/repos/${repo}/issues/${prNumber}/comments`)).find(
      (comment) => comment.user?.type === "Bot" && comment.body.includes(marker),
    );

  return {
    // `editOnly` skips creating one at all, which keeps a gate that has nothing
    // to say completely silent.
    async upsert(body, { editOnly = false } = {}) {
      const existing = await find();
      if (existing) {
        await api(`/repos/${repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: { body },
        });
        return;
      }
      if (!editOnly) {
        await api(`/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", body: { body } });
      }
    },

    async remove() {
      const existing = await find();
      if (existing) {
        await api(`/repos/${repo}/issues/comments/${existing.id}`, { method: "DELETE" });
      }
    },
  };
}
