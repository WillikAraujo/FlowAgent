# ADE Core

ADE Core é uma aplicação local em Node.js para visualizar worktrees Git e operar terminais por uma interface web. O projeto está em fase inicial; veja [a avaliação técnica](docs/PROJECT_ASSESSMENT.md) antes de usar com repositórios ou dados corporativos.

## Requisitos

- Node.js 24 LTS (ou versão compatível com as dependências)
- Git instalado e disponível no `PATH`
- Windows PowerShell ou Bash

## Começar

```sh
npm ci
npm start
```

Acesse `http://localhost:3333`. Para validar a sintaxe dos arquivos principais:

```sh
npm run check
```

Use apenas em ambiente local confiável enquanto autenticação e controles de acesso não estiverem implementados. O servidor permite criar terminais de shell e executar comandos.

## Fluxo de contribuição

1. Crie uma branch para cada mudança.
2. Mantenha alterações pequenas e descreva motivação, impacto e validação na revisão.
3. Execute `npm run check` antes de abrir uma solicitação de revisão.
4. Não inclua segredos, credenciais ou dados reais nos commits.
5. Registre riscos de segurança encontrados em `docs/PROJECT_ASSESSMENT.md` e priorize correções antes de disponibilizar o serviço a outros usuários.

O workflow em `.github/workflows/quality.yml` executa instalação reproduzível e checagem estática em pushes e pull requests.
