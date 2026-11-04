# Email delivery decision

**Status:** Planning

## Decision

SendGrid is the selected email provider for registration verification, password recovery, and account deletion messages. The app uses its Mail Send API; no SendGrid account, API key, or sender domain is provisioned by this repository.

Azure Communication Services Email was not selected for a new deployment because Microsoft has announced its retirement by September 30, 2028. Its Azure-managed domains also have fixed send limits of 5 messages per minute and 10 per hour per subscription, with no increase available.

## Azure resources

No Azure email resources are planned or created. The existing Azure SQL database remains unchanged.

## Remaining configuration

- Create and secure a SendGrid account with two-factor authentication.
- Authenticate the sender identity/domain and create a restricted Mail Send API key.
- Configure `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and a persistent `AUTH_CODE_PEPPER` outside source control.
- Verify real delivery after the provider configuration is supplied.
