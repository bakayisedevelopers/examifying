import { getEmailPortalBaseUrl, resolveEmailAppUrl } from './emailPortalUrls.js';

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const renderBrandedEmail = ({ profile = {}, name, heading, paragraphs = [], details = [], actionLabel, actionUrl }) => {
  const portalUrl = getEmailPortalBaseUrl(profile);
  const portalHomeUrl = resolveEmailAppUrl('/', profile);
  const resolvedActionUrl = actionUrl ? resolveEmailAppUrl(actionUrl, profile) : '';
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const htmlParagraphs = paragraphs.map((paragraph) => (
    `<p style="margin:0 0 16px;color:#cbd5e1;font-size:15px;line-height:1.7">${escapeHtml(paragraph)}</p>`
  )).join('');
  const textDetails = details.map(({ label, value }) => `${label}: ${value}`).join('\n');
  const htmlDetails = details.length ? `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;background:#111c2e;border:1px solid #26364b;border-radius:12px">
      ${details.map(({ label, value }) => `<tr><td style="padding:12px 14px;color:#94a3b8;font-size:13px;border-bottom:1px solid #26364b">${escapeHtml(label)}</td><td style="padding:12px 14px;color:#f8fafc;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #26364b">${escapeHtml(value)}</td></tr>`).join('')}
    </table>` : '';
  const safeActionUrl = actionUrl ? escapeHtml(resolvedActionUrl) : '';
  const action = actionLabel && actionUrl ? `
    <p style="margin:26px 0 8px">
      <a href="${safeActionUrl}" style="display:inline-block;border-radius:10px;background:#a3e635;background-image:linear-gradient(100deg,#bef264,#34d399);padding:13px 20px;color:#10210a;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(actionLabel)}</a>
    </p>` : '';
  const plainText = [greeting, '', heading, ...paragraphs, ...(textDetails ? ['', textDetails] : []), ...(actionUrl ? ['', `${actionLabel}: ${resolvedActionUrl}`] : []), '', 'Examifying — learn with purpose.'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#020617;font-family:Arial,Helvetica,sans-serif;color:#f8fafc">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(paragraphs[0] || heading)}</div>
    <table role="presentation" style="width:100%;background:#020617;padding:32px 12px"><tr><td align="center">
      <table role="presentation" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background:#0b1220;border:1px solid #1e293b;border-radius:20px;overflow:hidden">
        <tr><td style="padding:22px 28px;border-bottom:1px solid #1e293b;background:#0f172a">
          <table role="presentation"><tr><td style="vertical-align:middle"><img src="${portalUrl}/logo.png" width="42" height="42" alt="Examifying" style="display:block;border:0;border-radius:10px" /></td><td style="padding-left:12px;vertical-align:middle"><span style="font-size:20px;font-weight:800;letter-spacing:-.4px;color:#a3e635">Examifying</span><br /><span style="font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#94a3b8">Learn with purpose</span></td></tr></table>
        </td></tr>
        <tr><td style="padding:30px 28px 32px">
          <p style="margin:0 0 8px;color:#bef264;font-size:13px;font-weight:700">${escapeHtml(greeting)}</p>
          <h1 style="margin:0 0 20px;color:#f8fafc;font-size:25px;line-height:1.25">${escapeHtml(heading)}</h1>
          ${htmlParagraphs}${htmlDetails}${action}
          <p style="margin:26px 0 0;color:#64748b;font-size:12px;line-height:1.6">This is an account or service notification from Examifying.</p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #1e293b;color:#64748b;font-size:12px">Examifying · <a href="${portalHomeUrl}" style="color:#a3e635;text-decoration:none">Open your Examifying portal</a></td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  return { html, text: plainText };
};
