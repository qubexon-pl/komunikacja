-- Least-privilege access for the FastAPI app's Managed Identity (run once as an Entra admin of the database).
-- Replace [onward-api] with the name of the App Service / Container App whose system-assigned identity runs FastAPI
-- (or the name of the user-assigned identity). The identity gets only the rights its endpoints use, nothing else:
-- no DDL, no access to timetables, flights or other tables, and no db_owner / db_datawriter roles.

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'onward-api')
    CREATE USER [onward-api] FROM EXTERNAL PROVIDER;
GO

-- sign-in and sessions
GRANT SELECT, INSERT ON dbo.AppUser TO [onward-api];
GRANT SELECT, INSERT ON dbo.ExternalIdentity TO [onward-api];
GRANT SELECT ON dbo.LocalCredential TO [onward-api];
GRANT SELECT, INSERT, DELETE ON dbo.AuthSession TO [onward-api];
GRANT SELECT, INSERT, DELETE ON dbo.OAuthState TO [onward-api];

-- the user's own data
GRANT SELECT, INSERT, UPDATE ON dbo.UserFavorites TO [onward-api];
GRANT SELECT, INSERT, UPDATE ON dbo.UserPreference TO [onward-api];
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.TripPhoto TO [onward-api];
GO

-- shared trips and participants' live location (only while each person shares it)
GRANT SELECT, INSERT, DELETE ON dbo.TripShare TO [onward-api];
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.TripLocation TO [onward-api];
GRANT SELECT, INSERT, DELETE ON dbo.TripLocationViewer TO [onward-api];
GO
