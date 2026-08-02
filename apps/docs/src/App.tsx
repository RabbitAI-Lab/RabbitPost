const APP_URL = import.meta.env.VITE_APP_URL ?? "http://localhost:5173";

const FEATURES = [
  {
    icon: "⚡",
    title: "API Debugging",
    desc: "Full-featured request editor with Params, Headers, Body, Auth, Scripts and variable substitution — everything you need in one place.",
  },
  {
    icon: "📁",
    title: "Collections",
    desc: "Organize requests into collections and folders, drag to reorder, import from OpenAPI or share a public link with your team.",
  },
  {
    icon: "🌍",
    title: "Environments",
    desc: "Switch between dev / staging / production environments in one click. Variables are resolved automatically across the whole request.",
  },
  {
    icon: "🤖",
    title: "Automated Testing",
    desc: "Write pre-request scripts and test assertions with the rp.* API, then run entire collections from the built-in runner or CLI.",
  },
  {
    icon: "📐",
    title: "API Specs",
    desc: "Design-first workflow: define your API spec, validate it against best practices, and generate a ready-to-run collection.",
  },
  {
    icon: "👥",
    title: "Team Collaboration",
    desc: "Workspaces, teams and role-based access control keep everyone on the same page — from design to CI.",
  },
];

const QUICK_START_STEPS = [
  { cmd: "npm i -g rabbitpost-cli", note: "Install the CLI globally" },
  { cmd: "rabbitpost login", note: "Authenticate with your team" },
  { cmd: "rabbitpost run <collection> -e prod", note: "Run a collection in CI" },
];

export default function App() {
  return (
    <div className="page">
      {/* ── Nav ── */}
      <header className="nav">
        <a className="nav-brand" href="#top">
          <img src="/rabbit.svg" alt="RabbitPost" className="nav-logo" />
          <span>RabbitPost</span>
        </a>
        <nav className="nav-links">
          <a href="#features">Features</a>
          <a href="#quickstart">Quick Start</a>
        </nav>
        <a className="btn btn-primary btn-sm" href={APP_URL}>
          Open App ↗
        </a>
      </header>

      {/* ── Hero ── */}
      <section className="hero" id="top">
        <div className="hero-glow" aria-hidden />
        <span className="hero-badge">🥕 Open-source API collaboration platform</span>
        <h1 className="hero-title">
          Build &amp; test APIs,
          <br />
          <span className="gradient-text">at rabbit speed.</span>
        </h1>
        <p className="hero-sub">
          RabbitPost brings request debugging, environment management, automated testing and
          API design specs into one collaborative workspace for your whole team.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href={APP_URL}>
            Get Started
          </a>
          <a className="btn btn-ghost" href="#quickstart">
            Read the Docs
          </a>
        </div>

        {/* terminal mockup */}
        <div className="terminal">
          <div className="terminal-bar">
            <span className="dot dot-r" />
            <span className="dot dot-y" />
            <span className="dot dot-g" />
            <span className="terminal-title">rabbitpost — zsh</span>
          </div>
          <pre className="terminal-body">
            <code>
              <span className="t-prompt">$</span> rabbitpost run "Payment API" -e staging{"\n"}
              <span className="t-dim">✓ 12 requests · 48 assertions · 0 failures</span>{"\n"}
              <span className="t-ok">PASS</span>  completed in 1.8s 🥕
            </code>
          </pre>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="section" id="features">
        <h2 className="section-title">Everything an API team needs</h2>
        <p className="section-sub">
          From the first curl to production monitoring — one tool, zero context switching.
        </p>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article className="feature-card" key={f.title}>
              <span className="feature-icon">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Quick Start ── */}
      <section className="section" id="quickstart">
        <h2 className="section-title">Quick Start</h2>
        <p className="section-sub">Three commands from zero to your first automated run.</p>
        <div className="steps">
          {QUICK_START_STEPS.map((s, i) => (
            <div className="step" key={s.cmd}>
              <span className="step-num">{i + 1}</span>
              <div>
                <code className="step-cmd">{s.cmd}</code>
                <p className="step-note">{s.note}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="footer">
        <span>
          🥕 RabbitPost — Postman-like API collaboration, self-hosted &amp; open source.
        </span>
      </footer>
    </div>
  );
}
