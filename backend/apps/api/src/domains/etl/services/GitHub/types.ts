export interface GitHubRepositoryOwner {
  login: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  owner: GitHubRepositoryOwner;
}

export interface GitHubActor {
  id: number;
  login: string;
  display_login?: string;
  avatar_url?: string;
  url?: string;
}

export interface GitHubEventRepo {
  id: number;
  name: string;
  url: string;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  url?: string;
}

export interface GitHubIssueSummary {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state?: string;
  pull_request?: Record<string, unknown>;
}

export interface GitHubPullRequestSummary {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state?: string;
  merged?: boolean;
}

export interface GitHubCommentSummary {
  id: number;
  body?: string | null;
  html_url: string;
}

export interface GitHubReviewSummary {
  id: number;
  body?: string | null;
  html_url: string;
  state?: string;
}

export interface GitHubEvent {
  id: string;
  type: string;
  actor: GitHubActor;
  repo: GitHubEventRepo;
  payload: {
    action?: string;
    ref?: string;
    head?: string;
    before?: string;
    push_id?: number;
    size?: number;
    commits?: GitHubCommitSummary[];
    issue?: GitHubIssueSummary;
    comment?: GitHubCommentSummary;
    pull_request?: GitHubPullRequestSummary;
    review?: GitHubReviewSummary;
    review_comment?: GitHubCommentSummary;
    [key: string]: unknown;
  };
  public: boolean;
  created_at: string;
}

export interface GitHubRepositoryEvents {
  repository: GitHubRepository;
  events: GitHubEvent[];
}

export interface GitHubRepositoryEventsCursor {
  since?: string;
  repoPage?: number;
  repoIndex?: number;
  eventPage?: number;
}
