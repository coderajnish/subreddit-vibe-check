import type { AnalyzedPost } from "../types/reddit";

interface PostsListProps {
  posts: AnalyzedPost[];
}

/** Renders the empty state, or the 50 analyzed posts as tinted rows. */
export default function PostsList({ posts }: PostsListProps) {
  if (posts.length === 0) {
    return (
      <section className="empty-state" aria-label="No posts loaded">
        <span className="empty-emoji" aria-hidden="true">
          🧭
        </span>
        <p className="empty-title">No posts loaded yet.</p>
        <p className="empty-sub">
          Pick a preset or type a subreddit name above, then hit “Check the vibe”.
        </p>
      </section>
    );
  }

  return (
    <section className="posts" aria-label="Analyzed posts">
      <div className="posts-header">
        <h2>Top 50 hot posts</h2>
        <span className="posts-count">{posts.length} analyzed</span>
      </div>

      <ol className="posts-list">
        {posts.map((post, index) => (
          <li key={post.id} className={`post-row post-row--${post.sentimentLabel}`}>
            <span className="post-rank" aria-hidden="true">
              {index + 1}
            </span>

            <div className="post-body">
              <a
                className="post-title"
                href={`https://www.reddit.com${post.permalink || "#"}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {post.title}
              </a>
              <div className="post-meta">
                <span className="post-author">u/{post.author}</span>
                <span className="post-stat" title="Upvotes">
                  ▲ {Number(post.score ?? 0).toLocaleString()}
                </span>
                <span className="post-stat" title="Comments">
                  💬 {Number(post.num_comments ?? 0).toLocaleString()}
                </span>
              </div>
            </div>

            <span className={`badge badge--${post.sentimentLabel}`}>
              {post.sentimentLabel}
              <strong>{post.sentimentScore > 0 ? `+${post.sentimentScore}` : post.sentimentScore}</strong>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
