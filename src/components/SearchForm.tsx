import { useState, type FormEvent } from "react";

const PRESET_SUBREDDITS = ["nba", "soccer", "technology", "news", "wallstreetbets", "AskReddit"];

interface SearchFormProps {
  loading: boolean;
  onCheck: (rawInput: string) => void;
}

/**
 * Subreddit input + preset chips + the primary "Check the vibe" button.
 * Clicking a chip fills the input and immediately kicks off the analysis.
 */
export default function SearchForm({ loading, onCheck }: SearchFormProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loading && value.trim()) {
      onCheck(value);
    }
  };

  const handlePreset = (subreddit: string) => {
    setValue(subreddit);
    onCheck(subreddit);
  };

  return (
    <section className="search-panel" aria-label="Subreddit search">
      <form className="search-form" role="search" onSubmit={handleSubmit}>
        <div className="search-field">
          <span className="search-prefix" aria-hidden="true">
            r/
          </span>
          <input
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="nba"
            aria-label="Subreddit name"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            disabled={loading}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading || !value.trim()}>
          {loading ? "Checking…" : "Check the vibe"}
        </button>
      </form>

      <div className="preset-chips">
        <span className="preset-label">Popular:</span>
        {PRESET_SUBREDDITS.map((subreddit) => (
          <button
            key={subreddit}
            type="button"
            className="chip"
            disabled={loading}
            onClick={() => handlePreset(subreddit)}
          >
            r/{subreddit}
          </button>
        ))}
      </div>
    </section>
  );
}
