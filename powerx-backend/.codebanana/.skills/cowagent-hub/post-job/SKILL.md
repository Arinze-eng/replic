---
name: post-job
description: Post free job ads to 20+ job boards such as LinkedIn, Indeed, Ziprecruiter etc. to receive applicant resumes via email.
---

# JobPoster Skill

> ⚠️ **CRITICAL: Only use the `post_job` tool as the entry point!**
> 
> **DO NOT** call internal APIs directly (`genJD`, `postToLinkd`, `API_URL_*`). 
> **DO NOT** bypass `post_job` to call Fuku AI endpoints manually.
> 
> **Why?** The `post_job` function handles:
> - Input validation and sanitization
> - Location fuzzy matching
> - LinkedIn sync orchestration
> - Background monitoring setup
> 
> Skipping it will result in incomplete job postings and broken workflows.

🚀 **Quickly post job openings and collect resumes via natural language commands.**

JobPoster simplifies the hiring process by letting you post jobs through simple commands. It automatically matches locations, validates inputs, and provides shareable application links. Perfect for recruiters, hiring managers, and HR teams.

## ✨ Features

- **Natural Language Interface** - Post jobs with simple commands like "Hire a frontend engineer in Singapore"
- **Global City Support** - 100+ cities worldwide with fuzzy matching (Singapore, Hong Kong, New York, London, etc.)
- **AI Job Description** - Optional AI-powered JD generation for professional, compelling postings
- **Instant Application Links** - Get shareable URLs for candidates to apply directly
- **Resume Collection** - All applications sent to your specified email
- **LinkedIn Sync** - Automatic LinkedIn job posting integration (**no LinkedIn account binding required** — posts through Fuku AI's relay service)

## ⚠️ External Service Notice

This skill uses **Fuku AI** (https://hapi.fuku.ai) as a third-party job posting relay service to distribute jobs to multiple boards.

**🎉 No LinkedIn Account Binding Required!**

LinkedIn job postings are handled through Fuku AI's relay service — you do **NOT** need to connect or bind your personal LinkedIn account. The job is posted anonymously through Fuku AI's infrastructure.

**Data transmitted to Fuku AI:**

- Job title, description, company name, location
- Email address for receiving resumes
- LinkedIn company URL (optional, defaults to Fuku AI's company)

**Authentication:**

- Uses embedded client identifier (no user API key required)
- Free tier service provided by Fuku AI

**Security:**

- Job descriptions are sanitized before transmission to prevent prompt injection
- Job IDs are strictly validated (alphanumeric + hyphens only)
- Channel parameters are filtered to prevent log injection

By using this skill, you consent to transmitting the above data to Fuku AI's servers.

## 🔒 Security Best Practices

To minimize risks while using this skill:

### 1. Use a Dedicated Email Address

- **Do NOT use personal email** — Create a dedicated hiring email (e.g., `hiring@yourcompany.com` or `jobs+company@gmail.com`)
- **Use email aliases** — Gmail supports `youremail+company@gmail.com` for tracking sources
- **Forward to main inbox** — Set up auto-forwarding if needed

### 2. Sanitize Job Descriptions Before Submitting

- **Remove sensitive info** — Don't include internal salary ranges, confidential project names, or proprietary tech stack details
- **Avoid personal data** — Don't mention hiring manager names, direct contact info, or office security details
- **Keep it public-ready** — Write descriptions as if they'll be visible to anyone (because they will be)

### 3. Understand the Relay Model

- **Posts are anonymous** — Jobs appear under Fuku AI's accounts, not your company's LinkedIn page
- **No direct control** — You cannot edit/delete postings directly on job boards; contact support if changes needed
- **Third-party dependency** — If Fuku AI service goes down, postings may be affected

### 4. Monitor Active Postings

- **Save Job IDs** — Keep a record of all posted Job IDs for tracking
- **Check LinkedIn status** — Use `check_linkedin_status` to verify postings went live
- **Periodic audit** — Review active postings monthly to ensure they're still accurate

### 5. Limit Usage for Sensitive Roles

- **Executive/C-level positions** — Consider traditional channels for confidential searches
- **Internal transfers** — Use internal HR systems instead
- **Security-sensitive roles** — Avoid posting details that could reveal infrastructure or vulnerabilities

### 6. Background Polling Awareness

- **Monitor sub-agents spawn automatically** — Each job post creates a background monitor that polls every 2 minutes
- **Normal behavior** — This is expected and required for LinkedIn URL notification
- **No action needed** — Monitors auto-cleanup after completion

---

**Quick Checklist Before Posting:**

- [ ] Using dedicated hiring email (not personal)
- [ ] Job description contains no sensitive/confidential info
- [ ] Comfortable with third-party relay service
- [ ] Job ID saved for tracking
- [ ] Role is appropriate for public job boards

## 🎯 When to Use

Use this skill when you need to:

- Post a job opening quickly
- Create a job listing for any role
- Generate a resume collection link
- Share job postings with candidates
- Sync jobs to LinkedIn

## 🛠️ Tools

### post_job ⭐

Post job opening to 20+ job boards. Returns immediately with Job ID.

#### Parameters

| Parameter            | Required | Type   | Description                                                   | Default                                                      |
| -------------------- | -------- | ------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `title`              | ✅ Yes   | string | Job title (min 4 characters)                                  | -                                                            |
| `city_query`         | ✅ Yes   | string | City/location (supports fuzzy match)                          | -                                                            |
| `description`        | ✅ Yes   | string | Job description                                               | -                                                            |
| `email`              | ✅ Yes   | string | Email to receive resumes                                      | -                                                            |
| `company`            | ❌ No    | string | Company name                                                  | `"Your Company"`                                             |
| `industry`           | ❌ No    | string | Industry/field                                                | `"General"`                                                  |
| `linkedinCompanyUrl` | ❌ No    | string | LinkedIn company URL for posting                              | `"https://www.linkedin.com/company/110195078/admin/dashboard"` |

#### Response

Returns Job ID. **LinkedIn sync takes 5-60 minutes in background.**

---

### check_linkedin_status

Check LinkedIn sync status once. Returns URL if ready, or "Pending".

#### Parameters

| Parameter | Required | Type   | Description          | Example      |
| --------- | -------- | ------ | -------------------- | ------------ |
| `jobId`   | ✅ Yes   | string | The job ID to check  | `"abcd2345"` |

---

## 🤖 AI Assistant Workflow

### ⚠️ REQUIRED: Post Job + Spawn Monitor (Two Steps)

After `post_job` returns, you **MUST** spawn a sub-agent to monitor LinkedIn sync. Do NOT skip this.

**Step 1: Post Job**

```
result = await post_job({ title, city_query, description, email, ... })
```

**Step 2: Spawn Monitor (REQUIRED)**

Extract jobId from result, then spawn sub-agent:

```javascript
// Extract jobId from post_job result
const jobIdMatch = result.match(/Job ID:\s*`?([a-zA-Z0-9-]+)`?/);
const jobId = jobIdMatch?.[1];

// Spawn sub-agent to monitor
await sessions_spawn({
  task: `Monitor LinkedIn sync for job ID "${jobId}". Loop: call check_linkedin_status with jobId="${jobId}", wait 2 minutes, repeat up to 30 times until LinkedIn URL is returned. Notify user when URL is available.`,
  mode: "run",
  cleanup: "delete"
});

// Tell user
"✅ Job posted! Job ID: `xxx`. I'll notify you when LinkedIn sync completes (5-60 min)."
```

**⚠️ If you skip Step 2:**
- User will NOT receive LinkedIn URL
- Incomplete workflow

---

## 📦 Installation

### Install via ClawHub

```bash
clawhub install post-job
```

### Manual Installation

```bash
# Clone or download the skill
cd your-openclaw-workspace/skills

# Install dependencies
cd post-job
npm install
```

## 🔐 Security Notes

- **Email Privacy**: Resume emails are visible in job postings - use a dedicated hiring email
- **Rate Limiting**: API may have rate limits for high-volume posting

## 🐛 Troubleshooting

### Issue: Job posts but no confirmation

**Cause**: Response timeout or network issue

**Solution**: Check backend logs, verify API credentials, retry with `--force`

### Issue: City not recognized

**Cause**: City not in location database

**Solution**:

1. Check `assets/locations.json` for supported cities
2. Try alternative spelling (e.g., "New York" vs "NYC")
3. Add new city to database and republish

### Issue: Duplicate job postings

**Cause**: Multiple API calls due to retry logic

**Solution**: Check backend for duplicate jobs, implement request deduplication

## ❓ FAQ - Security & Privacy

**Q: Is my data safe with Fuku AI?**
A: Job data is transmitted to Fuku AI's servers for distribution. They act as a relay service. Avoid sharing confidential information in job descriptions.

**Q: Do I need to trust Fuku AI?**
A: Yes — this skill depends on their service to post jobs. Review their terms at https://www.fuku.ai if you have concerns.

**Q: Can I use this without LinkedIn sync?**
A: Yes — jobs are still posted to 20+ other boards. LinkedIn is optional background sync.

**Q: Will the job appear on MY LinkedIn company page?**
A: No — postings appear through Fuku AI's relay accounts, not your company's page. This is why no LinkedIn binding is required.

**Q: What happens if Fuku AI goes offline?**
A: Job posting may fail or LinkedIn sync may be delayed. The skill will return an error message.

**Q: Can I delete a job after posting?**
A: Contact Fuku AI support with your Job ID. Direct deletion through this skill is not currently supported.

**Q: Is the embedded credential a security risk?**
A: The embedded identifier is for Fuku AI's free tier access. It doesn't expose your personal credentials, but means jobs are posted under their service account.

**Q: Should I use this for confidential hiring?**
A: No — use traditional channels (internal HR systems, executive search firms) for sensitive or confidential roles.

## 🤝 Contributing

Found a bug or want to add more cities?

1. Fork the skill
2. Make your changes
3. Test thoroughly
4. Submit a pull request

## 📄 License

This skill is provided as-is for use with OpenClaw.

## 🆘 Support

For issues or questions:

- Check this SKILL.md for troubleshooting
- Review error messages carefully
- Contact developer email yangkai31@gmail.com if you run into any issues

---

**Happy Hiring! 🎉**