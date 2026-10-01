# Validação de configuração e execução da ADE

## Comandos

- `npm test`: build, todos os testes Node descobertos e testes React.
- `npm run test:e2e`: build e fluxo Electron em armazenamento/repositório temporários.
- `npm run check`: todas as verificações anteriores.

Os providers controlados existem apenas em `tests/fixtures` e no bootstrap de E2E. A aplicação distribuída usa os adapters reais e não inclui sessões ou agentes demonstrativos.

## Cobertura

Runtime: sessões preparadas por providers diferentes, início único, identidade entre sessões, falhas de inicialização, comunicação, permissões e exclusividade de edição por worktree. Codex: JSONL, deltas, stderr, término explícito e exclusão de raciocínio privado. OpenCode: handshake ACP, prompt, saída pública, espera e encerramento inesperado.

Persistência: preferências com gravação atômica, notas e vínculos, responsabilidades, contexto de tarefas e reconciliação de agentes após reinício. Segurança: credencial MCP obrigatória, Developer sem permissão para criar agentes e rejeição de arquivos fora da worktree.

UI: salvar e descartar preferências, disponibilidade sem inferir autenticação, preservação de formulários em falhas, isolamento de participantes e envio parcial sem duplicar entregas já confirmadas.

Electron: configuração → tarefa → agente → mensagem → encerramento → reinício. Capturas nas resoluções 1440×900, 1600×900 e 1920×1080 ficam em `test-results/`. O CI executa build e testes em Linux/Windows e E2E no Windows.

## Verificação real de provider

A suíte padrão não utiliza credenciais nem executa CLIs reais. Para validar uma instalação, abra Providers, consulte disponibilidade/versão e use uma tarefa de revisão em uma worktree descartável. Execute primeiro uma instrução sem alterações, confirme os eventos e encerre a sessão. No OpenCode, valide também uma mensagem posterior ao primeiro turno. Falha de login deve aparecer na tarefa; disponibilidade do executável não equivale a login confirmado.

## Limites atuais

- Codex continua usando o modelo definido pelo adapter; a UI não oferece seleção sem suporte efetivo.
- OpenCode não oferece resume após reinício nem shell/testes pelo adapter atual.
- Interromper uma operação não equivale a pausar e retomar sua execução interna.
- Equipes manuais recebem a instrução da tarefa individualmente. Dependências registradas são observáveis; não há scheduler automático.
- Arquivos são o estado Git da worktree, sem atribuição presumida a um agente. Prévia de texto limitada a 64 KB; listagem limitada a 200 entradas.
- Resultados de testes/reviews não são inventados a partir de texto de logs. Novos formatos estruturados precisam ser adicionados aos adapters.
