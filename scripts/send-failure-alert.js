const nodemailer = require('nodemailer');

const {
  EMAIL_REMETENTE,
  EMAIL_SENHA,
  EMAIL_ALERTA_FALHA = 'flavia@monitorlegislativo.com.br',
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_WORKFLOW,
  GITHUB_REF_NAME,
} = process.env;

async function main() {
  if (!EMAIL_REMETENTE || !EMAIL_SENHA || !EMAIL_ALERTA_FALHA) {
    console.error('Sem credenciais/destino para alerta interno.');
    process.exit(0);
  }

  const runUrl = GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? GITHUB_SERVER_URL + '/' + GITHUB_REPOSITORY + '/actions/runs/' + GITHUB_RUN_ID
    : '';

  const html = '<div style="font-family:Arial,sans-serif;max-width:760px;color:#111827">' +
    '<h2 style="color:#b42318;margin-bottom:8px">Falha no monitor Eletromídia Proposições</h2>' +
    '<p>O workflow falhou antes de completar a rodada.</p>' +
    '<p><strong>Workflow:</strong> ' + (GITHUB_WORKFLOW || '-') + '<br>' +
    '<strong>Branch:</strong> ' + (GITHUB_REF_NAME || '-') + '<br>' +
    '<strong>Run:</strong> ' + (runUrl ? '<a href="' + runUrl + '">' + runUrl + '</a>' : '-') + '</p>' +
    '<p style="color:#64748b;font-size:12px">Alerta interno. Não enviado para Eletromídia.</p>' +
    '</div>';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  await transporter.sendMail({
    from: '"Monitor Legislativo" <' + EMAIL_REMETENTE + '>',
    to: EMAIL_ALERTA_FALHA,
    subject: '[ALERTA INTERNO] Falha Eletromídia Proposições',
    html,
  });

  console.log('Alerta interno enviado para ' + EMAIL_ALERTA_FALHA);
}

main().catch((err) => {
  console.error('Erro ao enviar alerta interno:', err.message);
  process.exit(0);
});

