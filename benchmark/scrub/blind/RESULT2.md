# Secret scrubber, blind set

secrets caught 544/603 = 90.2% (95% interval 87.6-92.3%)
harmless changed 21/497 = 4.2% (95% interval 2.8-6.4%)

| Writer | Caught | Harmless changed |
|---|---:|---:|
| opus | 272/305 | 12/249 |
| sonnet | 272/298 | 9/248 |

| Theme | Caught | Harmless changed |
|---|---:|---:|
| hospital and clinic IT (EHR integrations, HL7/FHIR endpoints, lab systems, staff accounts) | 54/58 | 0/50 |
| online shops and marketplaces (Shopify, WooCommerce, Etsy, payment terminals, shipping label APIs) | 52/64 | 3/49 |
| game development and game servers (Steam, Epic, Unity services, Discord bots, dedicated server configs) | 48/57 | 2/50 |
| accounting, invoicing and banking tools (DATEV, Xero, QuickBooks, open banking APIs, a bookkeeper e-mail) | 55/58 | 3/50 |
| schools and universities (LMS like Moodle, student portals, exam software, a teacher sharing logins) | 58/63 | 0/49 |
| open-source maintainers (release signing, package registries, CI secrets, bots on GitHub and GitLab) | 55/60 | 5/50 |
| data engineering (Airflow, dbt, Snowflake, BigQuery service accounts, Kafka Connect, S3 buckets) | 59/59 | 4/49 |
| home lab and self-hosting (Proxmox, TrueNAS, Home Assistant, Nextcloud, Pi-hole, Tailscale, Vaultwarden) | 53/61 | 1/50 |
| travel and booking integrations (airline and hotel APIs, Amadeus, Booking.com, maps and geocoding keys) | 55/59 | 0/49 |
| freelancers and small agencies (client CMS logins, hosting panels, FTP, domain registrars, shared Google accounts) | 55/64 | 3/51 |
