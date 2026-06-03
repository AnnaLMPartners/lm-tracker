/**
 * LM Real Estate Partners — Daily Email Reminder Script
 * Groups dates with same category + due date across multiple properties
 * into ONE combined email per reminder window.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL    = process.env.FROM_EMAIL    || 'alerts@lmrep.com';
const FROM_NAME     = process.env.FROM_NAME     || 'LM Real Estate Partners';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://lm-tracker.vercel.app';

async function runReminders() {
  console.log(`\n[${new Date().toISOString()}] LM Reminder Job Starting...`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: team } = await supabase
    .from('team_members')
    .select('*')
    .eq('receives_reminders', true);

  if (!team?.length) { console.log('No team members. Exiting.'); return; }

  const { data: dates } = await supabase
    .from('dates')
    .select('*, properties(name, city, state)')
    .eq('is_active', true);

  if (!dates?.length) { console.log('No active dates. Exiting.'); return; }

  // Group dates by category + due_date + description so multi-property
  // dates send as ONE combined email
  const groups = {};
  for (const record of dates) {
    const keyDate = new Date(record.due_date + 'T00:00:00');
    keyDate.setHours(0, 0, 0, 0);
    const daysLeft = Math.ceil((keyDate - today) / 86400000);

    for (const windowDays of (record.reminder_days || [])) {
      if (daysLeft !== windowDays) continue;

      const groupKey = `${record.category}||${record.due_date}||${record.description}||${windowDays}`;
      if (!groups[groupKey]) {
        groups[groupKey] = {
          category: record.category,
          description: record.description,
          due_date: record.due_date,
          action_required: record.action_required,
          party: record.party,
          amount: record.amount,
          notes: record.notes,
          daysLeft,
          windowDays,
          properties: [],
          recordIds: [],
        };
      }
      groups[groupKey].properties.push(record.properties);
      groups[groupKey].recordIds.push(record.id);
    }
  }

  let totalSent = 0;

  for (const group of Object.values(groups)) {
    for (const member of team) {
      const alreadySent = await checkGroupSent(group.recordIds, group.windowDays, member.email);
      if (alreadySent) continue;

      const sent = await sendGroupEmail({ member, group });

      if (sent) {
        for (const recordId of group.recordIds) {
          await logSent(recordId, group.windowDays, member.email);
        }
        totalSent++;
      }
    }
  }

  console.log(`\n✓ Done. ${totalSent} reminder email(s) sent.\n`);
}

async function sendGroupEmail({ member, group }) {
  const { category, description, due_date, action_required, party, amount, notes, daysLeft, properties } = group;
  const urgencyColor = daysLeft <= 7 ? '#c53030' : daysLeft <= 30 ? '#b7791f' : '#0d1b2a';
  const urgencyLabel = daysLeft <= 7 ? 'URGENT' : daysLeft <= 30 ? 'ACTION REQUIRED' : 'REMINDER';
  const formattedDate = new Date(due_date + 'T00:00:00')
    .toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const propHTML = properties.length === 1
    ? `<div style="background:#f8f9fb;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#a0aec0;margin-bottom:6px">Property</div>
        <div style="font-size:18px;font-family:Georgia,serif;color:#0d1b2a">${properties[0].name}</div>
        <div style="font-size:13px;color:#718096">${properties[0].city}, ${properties[0].state}</div>
      </div>`
    : `<div style="background:#f8f9fb;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#a0aec0;margin-bottom:10px">Properties (${properties.length})</div>
        ${properties.map(p => `
          <div style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:500;color:#0d1b2a">
            ${p.name} <span style="font-size:12px;color:#718096;font-weight:400">${p.city}, ${p.state}</span>
          </div>`).join('')}
      </div>`;

  const details = [
    action_required && ['Action Required', action_required],
    party           && ['Counterparty / Lender', party],
    amount          && ['Amount', '$' + Number(amount).toLocaleString()],
    notes           && ['Notes', notes],
  ].filter(Boolean);

  const detailRows = details.map(([k,v]) => `
    <tr>
      <td style="padding:8px 16px;font-size:13px;color:#718096;width:160px">${k}</td>
      <td style="padding:8px 16px;font-size:13px;color:#1a202c">${v}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:Helvetica Neue,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f7f7f5">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="background:#0d1b2a;padding:24px 32px;border-radius:12px 12px 0 0">
  <table width="100%"><tr>
    <td><span style="background:#c8973a;display:inline-block;width:36px;height:36px;border-radius:6px;text-align:center;line-height:36px;font-family:Georgia,serif;font-size:18px;color:#0d1b2a;vertical-align:middle;margin-right:10px">LM</span>
    <span style="color:white;font-size:16px;font-family:Georgia,serif;vertical-align:middle">LM Real Estate Partners</span></td>
    <td align="right"><span style="background:${urgencyColor};color:white;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px">${urgencyLabel}</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:white;padding:32px">
  <p style="font-size:14px;color:#718096;margin:0 0 4px">Hi ${member.full_name},</p>
  <h1 style="font-family:Georgia,serif;font-size:22px;color:#0d1b2a;margin:8px 0 20px;font-weight:400">
    ${category} - ${daysLeft} day${daysLeft !== 1 ? 's' : ''} away
  </h1>
  ${propHTML}
  <div style="background:#0d1b2a;border-radius:10px;padding:18px 20px;margin-bottom:20px;text-align:center">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.5);margin-bottom:6px">Due Date</div>
    <div style="font-size:20px;color:white;font-family:Georgia,serif">${formattedDate}</div>
    <div style="font-size:13px;color:#c8973a;margin-top:4px;font-weight:600">${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining</div>
  </div>
  <div style="font-size:13px;color:#4a5568;background:#fffbeb;border:1px solid #f6e05e;border-radius:8px;padding:12px 16px;margin-bottom:20px">${description}</div>
  ${details.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
    <tr style="background:#f8f9fb"><td colspan="2" style="padding:10px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a0aec0">Details</td></tr>
    ${detailRows}
  </table>` : ''}
  <div style="text-align:center;margin-top:24px">
    <a href="${DASHBOARD_URL}" style="display:inline-block;background:#c8973a;color:#0d1b2a;font-size:14px;font-weight:700;padding:12px 28px;border-radius:7px;text-decoration:none">View in Dashboard</a>
  </div>
</td></tr>
<tr><td style="background:#f0ece4;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center">
  <p style="font-size:11px;color:#a0aec0;margin:0">LM Real Estate Partners - Southeast Industrial Portfolio - Automated reminder</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const propNames = properties.map(p => p.name).join(' & ');
  try {
    await sgMail.send({
      to: { email: member.email, name: member.full_name },
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: `[LM] ${category} - ${propNames} - ${daysLeft}d`,
      html,
    });
    console.log(`  Sent to ${member.email}: ${category} @ ${propNames} (${daysLeft}d)`);
    return true;
  } catch (err) {
    console.error(`  Failed ${member.email}:`, err.message);
    return false;
  }
}

async function checkGroupSent(recordIds, days, email) {
  // Check if already sent today for this date+days+email combination
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  for (const id of recordIds) {
    const { data, error } = await supabase
      .from('reminder_log')
      .select('id, sent_at')
      .eq('record_id', id)
      .eq('days_before', days)
      .eq('recipient_email', email);
    if (error) { console.warn('Log check error:', error.message); continue; }
    if (data && data.length > 0) {
      // Check if any were sent today
      const sentToday = data.some(row => {
        const sentDate = (row.sent_at || '').split('T')[0];
        return sentDate === todayStr;
      });
      if (sentToday) {
        console.log(`  ⏭ Already sent to ${email} for date_id ${id} (${days}d) today — skipping`);
        return true;
      }
    }
  }
  return false;
}

async function logSent(dateId, days, email) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('reminder_log').insert({
    record_id: dateId,
    record_type: 'date',
    days_before: days,
    recipient_email: email,
    status: 'sent',
    sent_at: now,
  });
  if (error) console.warn('Log insert error:', error.message);
  else console.log(`  📝 Logged: record_id=${dateId}, days=${days}, email=${email}`);
}

// ── WEEKLY DIGEST (Mondays only) ──
async function runWeeklyDigest(team, dates, properties) {
  const today = new Date();
  if (today.getDay() !== 1) return; // 1 = Monday

  console.log('[Weekly Digest] Running Monday digest...');

  // Get all dates due in 30-90 days
  const upcoming = dates.filter(d => {
    const due = new Date(d.due_date + 'T00:00:00');
    due.setHours(0,0,0,0);
    const daysLeft = Math.ceil((due - today) / 86400000);
    return daysLeft >= 30 && daysLeft <= 90;
  });

  if (!upcoming.length) {
    console.log('  No dates in 30-90 day window for digest.');
    return;
  }

  // Group by category
  const byCategory = {};
  upcoming.forEach(d => {
    if (!byCategory[d.category]) byCategory[d.category] = [];
    byCategory[d.category].push(d);
  });

  // Sort each category by due date
  Object.keys(byCategory).forEach(cat => {
    byCategory[cat].sort((a,b) => new Date(a.due_date) - new Date(b.due_date));
  });

  const propMap = {};
  properties.forEach(p => { propMap[p.id] = p.name; });

  // Build email HTML
  const categoryRows = Object.entries(byCategory).map(([cat, items]) => {
    const rows = items.map(d => {
      const due = new Date(d.due_date + 'T00:00:00');
      const daysLeft = Math.ceil((due - today) / 86400000);
      const propName = propMap[d.property_id] || '—';
      const fmtDate = due.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const urgencyColor = daysLeft <= 30 ? '#b7791f' : '#2d7d46';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 12px;font-size:13px;color:#0d1b2a;font-weight:500">${propName}</td>
        <td style="padding:8px 12px;font-size:13px;color:#4a5568">${d.description}</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:500;white-space:nowrap">${fmtDate}</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:${urgencyColor}">${daysLeft}d</td>
        <td style="padding:8px 12px;font-size:12px;color:#718096">${d.action_required||'—'}</td>
      </tr>`;
    }).join('');

    return `<tr><td colspan="5" style="padding:14px 12px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a0aec0;background:#f8f9fb">${cat}</td></tr>
    ${rows}`;
  }).join('');

  const weekStr = today.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:Helvetica Neue,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f7f7f5">
<tr><td align="center"><table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
<tr><td style="background:#0d1b2a;padding:24px 32px;border-radius:12px 12px 0 0">
  <table width="100%"><tr>
    <td><span style="background:#c8973a;display:inline-block;width:36px;height:36px;border-radius:6px;text-align:center;line-height:36px;font-family:Georgia,serif;font-size:18px;color:#0d1b2a;vertical-align:middle;margin-right:10px">LM</span>
    <span style="color:white;font-size:16px;font-family:Georgia,serif;vertical-align:middle">LM Real Estate Partners</span></td>
    <td align="right"><span style="background:#2d7d46;color:white;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px">WEEKLY DIGEST</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:white;padding:28px 32px">
  <h1 style="font-family:Georgia,serif;font-size:20px;color:#0d1b2a;margin:0 0 6px;font-weight:400">Key Dates — Next 30 to 90 Days</h1>
  <p style="font-size:13px;color:#718096;margin:0 0 24px">Week of ${weekStr} · ${upcoming.length} upcoming deadline${upcoming.length!==1?'s':''}</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
    <tr style="background:#f8f9fb">
      <th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#a0aec0;text-align:left">Property</th>
      <th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#a0aec0;text-align:left">Description</th>
      <th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#a0aec0;text-align:left">Due Date</th>
      <th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#a0aec0;text-align:left">Days</th>
      <th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#a0aec0;text-align:left">Action</th>
    </tr>
    ${categoryRows}
  </table>
  <div style="text-align:center;margin-top:24px">
    <a href="${DASHBOARD_URL}" style="display:inline-block;background:#c8973a;color:#0d1b2a;font-size:14px;font-weight:700;padding:12px 28px;border-radius:7px;text-decoration:none">View Full Dashboard</a>
  </div>
</td></tr>
<tr><td style="background:#f0ece4;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center">
  <p style="font-size:11px;color:#a0aec0;margin:0">LM Real Estate Partners · Weekly Digest · Every Monday at 9 AM</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  for (const member of team) {
    try {
      await sgMail.send({
        to: { email: member.email, name: member.full_name },
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `[LM] Weekly Digest — ${upcoming.length} Key Dates (30-90 Days)`,
        html,
      });
      console.log(`  ✉ Weekly digest sent to ${member.email}`);
    } catch(err) {
      console.error(`  ✗ Digest failed ${member.email}:`, err.message);
    }
  }
}

async function main() {
  await runReminders();

  // Also load data for weekly digest
  const today = new Date();
  if (today.getDay() === 1) {
    const { data: team } = await supabase.from('team_members').select('*').eq('receives_reminders', true);
    const { data: dates } = await supabase.from('dates').select('*').eq('is_active', true);
    const { data: properties } = await supabase.from('properties').select('id, name');
    if (team && dates && properties) {
      await runWeeklyDigest(team, dates, properties);
    }
  }
}

main().catch(console.error);
