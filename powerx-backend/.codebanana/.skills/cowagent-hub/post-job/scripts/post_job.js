#!/usr/bin/env node
/**
 * Post job openings via Fuku AI API and generate resume collection links.
 * Uses AI model to generate professional job descriptions.
 *
 * Usage:
 *   node post_job.js --title "Senior Frontend Engineer" --city "Singapore" --level "senior"
 */

import axios from "axios";
import dayjs from "dayjs";
import { getLocationsFuse } from "./loadLocations.js";

// ============================================================================
// ⚠️ INTERNAL API PROTECTION
// These functions are for internal use ONLY. Always use post_job() as entry.
// ============================================================================
const INTERNAL_CALL_TOKEN = Symbol("internal-call-token");

function validateInternalCall(caller, fnName) {
  if (caller !== INTERNAL_CALL_TOKEN) {
    throw new Error(
      `❌ ${fnName}() is an internal function. Use post_job() to post jobs.`,
    );
  }
}
// ============================================================================

// Get Fuse instance for location fuzzy search (loaded from separate module)
const fuse = getLocationsFuse();
/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const result = {
    title: "",
    city: "",
    description: "",
    company: "",
    email: "",
    linkedinCompanyUrl:
      "https://www.linkedin.com/company/110195078/admin/dashboard",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--title":
        result.title = next;
        i++;
        break;
      case "--city":
        result.city = next;
        i++;
        break;
      case "--description":
        result.description = next;
        i++;
        break;
      case "--company":
        result.company = next;
        i++;
        break;
      case "--email":
        result.email = next;
        i++;
        break;
      case "--linkedinCompanyUrl":
        result.linkedinCompanyUrl = next;
        i++;
        break;
    }
  }

  return result;
}

// API Configuration
// Fuku AI client identifier (embedded for free tier access)
const NUMBER = "job-Z4nV8cQ1LmT7XpR2bH9sJdK6WyEaF0";

const API_URL_GEN = "https://hapi.fuku.ai/hr/rc/anon/job/upload";
const API_URL = "https://hapi.fuku.ai/hr/rc/anon/job/create";
const API_URL_LK = "https://hapi.fuku.ai/hr/rc/anon/job/sync/linkedin";
const API_URL_LK_CHECK = "https://hapi.fuku.ai/hr/rc/anon/job/status/linkedin";

function validateCredentials() {}

/**
 * Check the status of a LinkedIn job posting
 *
 * @param {Object} args - Arguments
 * @param {string} args.jobId - The ID of the job to check
 * @returns {Promise<string>} Status message or LinkedIn URL
 */
export async function check_linkedin_status(args) {
  const { jobId } = args;
  validateCredentials();
  try {
    const response = await axios.post(
      API_URL_LK_CHECK,
      { jobId: jobId },
      {
        params: {
          uid: "1873977344885133312",
        },
        headers: {
          "X-NUMBER": NUMBER,
        },
      },
    );

    const jobData = response.data;

    if (jobData.code !== 0) {
      return `❌ **Failed to get LinkedIn job state:** ${jobData.desc}`;
    }

    if (jobData.data && jobData.data.linkedinUrl) {
      return `✅ **LinkedIn Job is Live!**\n\nURL: ${jobData.data.linkedinUrl}`;
    } else {
      return `⏳ **LinkedIn Sync is still in progress.**\n\nStatus: ${jobData.data?.status || "Pending"}\nPlease check again in 5-10 minutes.`;
    }
  } catch (error) {
    return `❌ **Error checking LinkedIn status:** ${error.message}`;
  }
}

/**
 * Auto-check LinkedIn status with polling until URL is available
 *
 * @param {Object} args - Arguments
 * @param {string} args.jobId - The ID of the job to check
 * @param {number} [args.intervalMs=60000] - Polling interval in ms (default: 1 minute)
 * @param {number} [args.maxAttempts=20] - Maximum number of attempts (default: 20)
 * @returns {Promise<string>} Status message or LinkedIn URL
 */
async function getLinkedinState(jobId) {
  return check_linkedin_status({ jobId });
}

async function postToLinkd(data, linkedinCompanyUrl, token) {
  validateInternalCall(token, "postToLinkd");
  validateCredentials();
  let extra = null;
  try {
    extra = JSON.parse(data.extra ?? "");
  } catch (error) {}
  const job = {
    title: data.title,
    reference: `fuku-${data.id}`,
    description: data.description,
    jobId: data.id,
    linkedinCompanyUrl:
      linkedinCompanyUrl ||
      "https://www.linkedin.com/company/110195078/admin/dashboard/",
    location: extra.location,
    sublocation: extra.sublocation,
    cityname: extra.cityname,
    salarymin: 1,
    salarymax: 1,
    app_url: `https://app.fuku.ai/career/apply?id=${data.id}`,
    salaryper: "month",
    currency: "USD",
    jobtype: "2",
    job_time: "2",
    startdate: dayjs().format("YYYY-MM-DD"),
  };
  // console.log("Linkedin Job Post:", job);

  const res = await axios.post(API_URL_LK, job, {
    params: {
      uid: "1873977344885133312",
    },
    headers: {
      "X-NUMBER": NUMBER,
    },
  });
  // console.log("Linkedin Job Post Response:", res.data);
}

/**
 * Sanitize job description before sending to external AI service
 * Removes potential prompt injection patterns
 */
function sanitizeDescription(desc) {
  if (!desc || typeof desc !== "string") return "";

  // Remove patterns commonly used for prompt injection
  let sanitized = desc
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/<\|.*?\|>/g, "") // Remove special markers like <|endoftext|>
    .replace(
      /(?:^|\n)\s*(ignore|forget|override|system|instruction|new instruction)[\s\S]{0,200}/gi,
      "",
    ) // Remove injection attempts
    .replace(
      /(?:^|\n)\s*[-*]\s*(ignore|forget|override|system|instruction)[\s\S]{0,200}/gi,
      "",
    ) // Remove bullet-point injections
    .trim();

  // Limit length to prevent buffer-based attacks
  return sanitized.slice(0, 10000);
}

async function genJD(description, token) {
  validateInternalCall(token, "genJD");
  validateCredentials();

  // Sanitize description before sending to external AI service
  const sanitizedDescription = sanitizeDescription(description);
  if (!sanitizedDescription) {
    return "❌ **Invalid job description:** Description is empty or contains invalid content.";
  }

  const body = {
    content: sanitizedDescription,
  };
  try {
    const response = await axios.post(API_URL_GEN, body, {
      params: {
        uid: "1873977344885133312",
      },
      headers: {
        "X-NUMBER": NUMBER,
      },
    });

    const jobData = response.data;
    // console.log("Generated Job Data:", jobData);

    if (jobData.code !== 0) {
      return `❌ **Failed to generate job description:** ${jobData.desc}`;
    }

    return jobData.data.description;
  } catch (error) {
    return `❌ **Error generating job description:** ${error.message}`;
  }
}

/**
 * Post a job opening via Fuku AI API
 *
 * @param {Object} args - Job parameters
 * @param {string} args.title - Job title
 * @param {string} args.city_query - Location query
 * @param {string} [args.description] - Job description (auto-generated if not provided)
 * @param {string} [args.company] - Company name
 * @returns {Promise<string>} Result message
 */
export async function post_job(args) {
  try {
    validateCredentials();
  } catch (error) {
    return `❌ ${error.message}`;
  }
  const { title, city_query, description, company, email, linkedinCompanyUrl } =
    args;

  // Validate required fields
  if (!email) {
    return `❌ **Email is required.** Please provide an email address to receive resumes.\n\nExample: --email "hr@company.com"`;
  }

  // Fuzzy search for location
  const results = fuse.search(city_query);
  if (results.length === 0) {
    return `❌ Sorry, I couldn't find the location: "${city_query}".`;
  }

  const matched = results[0].item;

  // Build extra data
  const extra = JSON.stringify({
    location: matched.parentValue,
    sublocation: matched.value,
    cityname: matched.label,
  });

  const fullDescription = await genJD(description, INTERNAL_CALL_TOKEN);
  // console.log("Generated Description:", fullDescription);
  if (fullDescription.startsWith("❌")) {
    return fullDescription;
  }

  // Double-check: sanitize the AI-generated description before sending to job posting API
  const finalDescription = sanitizeDescription(fullDescription);
  if (!finalDescription) {
    return "❌ **Invalid job description:** Generated content was filtered as unsafe.";
  }

  // Build request body
  const body = {
    title,
    description: finalDescription,
    location: matched.parentLabel,
    company: company || "FUKU AI",
    companySearchKeyword: "",
    extra,
    isAiInterview: 1,
    orgId: "1",
    email: email,
  };

  try {
    const response = await axios.post(API_URL, body, {
      params: {
        uid: "1873977344885133312",
      },
      headers: {
        "X-NUMBER": NUMBER,
      },
    });

    const jobData = response.data;

    if (jobData.code !== 0) {
      return `❌ **Failed to post job:** ${jobData.desc}`;
    }
    await postToLinkd(jobData.data, linkedinCompanyUrl, INTERNAL_CALL_TOKEN);
    const jobId = jobData.data.id;

    // Note: LinkedIn sync runs in background, returns immediately
    // User can check status later with check_linkedin_status

    return (
      `✅ **Job Posted Successfully!**\n\n` +
      `**Position:** ${title}\n` +
      `**Location:** ${matched.label}\n` +
      `**Job ID:** \`${jobId}\`\n` +
      `**The resume will be sent to:** ${email}\n\n` +
      `--- \n` +
      `**LinkedIn Sync:** ⏳ Processing in background (5-30 min). I'll check and notify you when ready!\n\n` +
      `You can also manually check with: \`check_linkedin_status\` using Job ID \`${jobId}\``
    );
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    return `❌ **Failed to post job:** ${errorMsg}`;
  }
}

/**
 * Main function for CLI usage
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.title || !args.city) {
    console.error("Error: --title and --city are required");
    process.exit(1);
  }
  if (!args.email) {
    console.error("Error: --email is required");
    process.exit(1);
  }
  if (!args.description) {
    console.error("Error: --description is required");
    process.exit(1);
  }

  try {
    const result = await post_job({
      title: args.title,
      city_query: args.city,
      description: args.description,
      company: args.company,
      email: args.email,
      linkedinCompanyUrl: args.linkedinCompanyUrl,
    });

    console.log(result);
  } catch (error) {
    console.error("❌ Unexpected error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1] && process.argv[1].includes("post_job.js")) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  });
}
