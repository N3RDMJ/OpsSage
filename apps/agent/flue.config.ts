// flue project config. Agents live at .flue/agents/*.ts; skills at
// .agents/skills/**.md (auto-discovered). Build target is `node` for ECS;
// `cloudflare` is available if we ever swap.
export default {
  agentsDir: '.flue/agents',
  skillsDir: '.agents/skills',
  build: {
    target: 'node',
    outDir: 'dist',
  },
  dev: {
    port: Number.parseInt(process.env.PORT ?? '8080', 10),
  },
};
