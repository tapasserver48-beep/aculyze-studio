# Plan: what to take from awesome-llm-apps for Aculyze Studio

Source: https://github.com/Shubhamsaboo/awesome-llm-apps (Apache-2.0: we may reuse it with credit)
Reviewed: 2026-11-25. Status: **plan only**.

## 1. What is in the repo

About 197 runnable projects, almost all small **Python** demos (Streamlit, Agno, CrewAI, Google ADK, OpenAI Agents SDK), each needing its own OpenAI / Gemini / SerpAPI keys.

| Section | Count | Examples |
|---|---|---|
| Starter AI agents | 17 | travel, data analysis, data visualisation, web scraping, research, blog-to-podcast |
| Advanced single agents | 18 | customer support, meeting, deep research, email GTM, personal finance, consultant, journalist |
| Multi-agent apps | 17 | email GTM outreach, product launch intelligence, domain deep research, trust layer |
| Agent teams | 17 | sales intelligence, competitor intelligence, recruitment, legal, finance, SEO audit, services agency, travel (TripCraft), UI/UX feedback, design |
| MCP agents | 8 | travel planner (Airbnb + Google Maps MCP), GitHub, Notion, browser, multi-MCP router |
| RAG tutorials | 24 | corrective RAG, hybrid search, knowledge-graph RAG with citations, vision RAG, database routing |
| LLM apps with memory | 7 | personalised memory, travel agent with memory, multi-LLM memory |
| Chat with X | 7 | PDF, Gmail, GitHub, YouTube, research papers |
| Voice agents | 4 | customer support voice, audio tour, insurance claim live team |
| Always-on agents | 2 | HN briefing, release radar |
| Generative UI | 8 | dashboard canvas, deep research UI, financial coach, MCP app builder |
| Agent skills | 9 | advisor-orchestrator-worker, first-reader, scope-creep-detector, thinking-out-loud (SKILL.md files for coding agents) |
| Other | ~60 | game agents, fine-tuning, crash courses, optimisation tools |

## 2. How we use it

**Port the ideas to Node; don't run the Python apps.** The same reasons as the travel plan apply: one Render service, our existing NVIDIA / LM Studio model and search, our login, Postgres docstore, approvals and Aurora UI. Each feature we take gets a header comment crediting the source folder.

Each app is used for one of three things:
- **Feature**: a new AI employee or capability.
- **Pattern**: a better way to build something we already have.
- **Design**: UI/UX reference.

## 3. Shortlist mapped to Aculyze Studio

### Tier 1: fits what the product already does (business AI employees)

| Repo app | Use | Where it plugs in | Phase |
|---|---|---|---|
| `agent_teams/ai_sales_intelligence_agent_team` | Feature | Sales Agent: account research, deal briefs on top of LMS data | 04.5 |
| `multi_agent_apps/ai_email_gtm_outreach_agent`, `single_agent_apps/ai_email_gtm_reachout_agent` | Feature | Outreach drafts through our Gmail integration, **send only after approval** | 04.5 |
| `single_agent_apps/ai_customer_support_agent`, `voice_ai_agents/customer_support_voice_agent` | Pattern | Customer Executive chatbot: memory of past visitors; voice later | 04.4 |
| `rag_tutorials/corrective_rag`, `hybrid_search_rag`, `knowledge_graph_rag_citations` | Pattern | Customer Executive knowledge retrieval: better answers with citations, "I don't know" when retrieval is weak | 04.4 |
| `single_agent_apps/ai_meeting_agent` | Feature | Meeting prep briefs from Google Calendar plus web research | 04.5 |
| `agent_teams/ai_competitor_intelligence_agent_team`, `product_launch_intelligence_agent`, `starter/ai_startup_trend_analysis_agent` | Feature | New **Research** AI employee | 04.5 |
| `single_agent_apps/ai_deep_research_agent`, `multi_agent_apps/multi_agent_researcher` | Pattern | Upgrade Zara's research pipeline (`src/orchestrator/research`): planner → parallel researchers → writer | 04.4 |
| `starter/ai_data_analysis_agent`, `ai_data_visualisation_agent` | Feature | "Ask your data": upload Excel/CSV, get answers and charts (Command Centre, Executive reports) | 04.5 |
| `chat_with_X_tutorials/chat_with_pdf` | Pattern | Fills the gap in the new documents feature: **reading PDF files** (PDF → Word, questions about a PDF) | 04.3 |
| `agent_teams/ai_recruitment_agent_team`, `advanced_llm_apps/resume_job_matcher` | Feature | HR helper for LMS staff: screen CVs against a job description | later |
| `agent_teams/ai_travel_planner_agent_team` (TripCraft), `mcp_ai_agents/ai_travel_planner_mcp_agent_team` | Feature | Travel Planner, see `plan-travel-planner.md` | 04.5 |

### Tier 2: makes the platform stronger (roadmap 04.4 and 04.6)

| Repo app | Use | Where |
|---|---|---|
| `llm_apps_with_memory_tutorials/llm_app_personalized_memory`, `multi_llm_memory` | Pattern | 04.4 agent memory: per-user facts that Zara and AI employees remember |
| `agent_teams/ai_services_agency`, `agent_skills/advisor-orchestrator-worker` | Pattern | Chief of Staff hands work to employees (04.4) |
| `multi_agent_apps/multi_agent_trust_layer`, `trust_gated_agent_team`, `single_agent_apps/ai_agent_governance` | Pattern | 04.6 controls: trust levels, cost limits, stop switch, audit log |
| `always_on_agents/always_on_hn_briefing_agent`, `release_radar_agent` | Feature | New Automations templates: "daily industry briefing to my Inbox" |
| `mcp_ai_agents/multi_mcp_agent_router`, `notion_mcp_agent`, `github_mcp_agent` | Pattern | We already have `src/services/mcp/manager.js`; adds Notion / GitHub as "soon" integrations (04.5) |
| `starter/ai_blog_to_podcast_agent` | Feature | Content AI employee: blog → audio summary |

### Tier 3: UI/UX design references

| Repo app | What to borrow |
|---|---|
| `generative_ui_agents/ai-dashboard-canvas-agent` | AI answers that render as live cards and charts (Executive and Command Centre dashboards) |
| `generative_ui_agents/ai-deep-research-agent` | Showing research progress: plan, sources being read, then the report |
| `generative_ui_agents/ai-financial-coach-agent` | Friendly data storytelling for the Sales / Executive pages |
| `agent_teams/multimodal_uiux_feedback_agent_team`, `multimodal_design_agent_team` | Feature idea: Zara reviews a screenshot of a page and gives UI/UX feedback |
| TripCraft `client/` (Next.js + shadcn) | Trip form, plan status and plan pages for the Travel Planner |

### Not relevant to this product

Game-playing agents, fine-tuning, framework crash courses, medical imaging, tarot, breakup recovery, music generation, x402 crypto payments, token optimisers.

### Agent skills (for us as developers, not app features)

`agent_skills/*` are SKILL.md files for coding agents like Claude Code, not product features. `first-reader`, `scope-creep-detector` and `dependency-doctor` could be installed next to the `frontend-design` skill this repo already has in `.agents/skills/`. Optional.

## 4. Suggested order

1. **04.3 (now):** finish documents (commit plus restart/deploy) and add **PDF reading**, borrowing from `chat_with_pdf`.
2. **04.4:** agent memory + corrective / hybrid RAG for Customer Executive + a better research pipeline.
3. **04.5 new AI employees, one at a time:** Research → Sales intelligence + Email outreach → Travel Planner → Data analyst → Meeting prep.
4. **04.6:** trust/governance controls borrowed from the trust-layer apps.

Each new AI employee follows the existing rules: it acts as the human who asked, writes need approval, it has its own `--agent-*` colour, and its data is saved through Postgres / docstore.

## 5. Open questions

1. Is the order in section 4 right, or is there a business priority (for example Sales outreach first)?
2. Should each AI employee get its own page (like Executive), or live inside Zara chat plus Tasks?
