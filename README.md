# Monitor Proposicoes Eletromidia

Monitor interno de proposicoes novas para SP/RJ:

- ALESP
- CMSP
- ALERJ
- CMRJ

Roda duas vezes ao dia, na trilha das 8h e 16h BRT, e envia email interno somente quando houver proposicao nova filtrada por termos de interesse da Eletromidia.

## Regras

- Uso interno apenas.
- Nao envia para cliente.
- Nao envia email vazio.
- Primeiro run marca o universo atual como visto para evitar backlog antigo.
- Estado proprio em `estado.json`.

## Rodar local

```bash
npm install
npm run dry-run
```

## Variaveis

- `EMAIL_REMETENTE`
- `EMAIL_SENHA`
- `EMAIL_DESTINO`
- `DRY_RUN=true` para nao enviar email nem salvar estado.
