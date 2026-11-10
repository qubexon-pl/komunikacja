IF OBJECT_ID(N'dbo.GtfsFeedImport', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsFeedImport (
        agency_code NVARCHAR(10) NOT NULL,
        source_hash CHAR(64) NOT NULL,
        imported_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_GtfsFeedImport PRIMARY KEY (agency_code),
        CONSTRAINT CK_GtfsFeedImport_Agency CHECK (agency_code IN (N'ztm', N'pks'))
    );
END;
GO

IF OBJECT_ID(N'dbo.Agency', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Agency (
        agency_code NVARCHAR(10) NOT NULL,
        agency_name NVARCHAR(100) NOT NULL,
        CONSTRAINT PK_Agency PRIMARY KEY (agency_code)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsRoute', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsRoute (
        agency_code NVARCHAR(10) NOT NULL,
        route_id NVARCHAR(200) NOT NULL,
        short_name NVARCHAR(100) NOT NULL,
        long_name NVARCHAR(300) NOT NULL,
        route_color CHAR(7) NULL,
        text_color CHAR(7) NULL,
        route_type INT NOT NULL,
        CONSTRAINT PK_GtfsRoute PRIMARY KEY (agency_code, route_id),
        CONSTRAINT FK_GtfsRoute_Agency FOREIGN KEY (agency_code) REFERENCES dbo.Agency (agency_code)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsStop', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsStop (
        agency_code NVARCHAR(10) NOT NULL,
        stop_id NVARCHAR(200) NOT NULL,
        stop_name NVARCHAR(300) NOT NULL,
        stop_code NVARCHAR(100) NOT NULL,
        latitude FLOAT NOT NULL,
        longitude FLOAT NOT NULL,
        CONSTRAINT PK_GtfsStop PRIMARY KEY (agency_code, stop_id),
        CONSTRAINT FK_GtfsStop_Agency FOREIGN KEY (agency_code) REFERENCES dbo.Agency (agency_code)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsService', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsService (
        agency_code NVARCHAR(10) NOT NULL,
        service_id NVARCHAR(200) NOT NULL,
        CONSTRAINT PK_GtfsService PRIMARY KEY (agency_code, service_id),
        CONSTRAINT FK_GtfsService_Agency FOREIGN KEY (agency_code) REFERENCES dbo.Agency (agency_code)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsServiceCalendar', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsServiceCalendar (
        agency_code NVARCHAR(10) NOT NULL,
        service_id NVARCHAR(200) NOT NULL,
        monday BIT NOT NULL,
        tuesday BIT NOT NULL,
        wednesday BIT NOT NULL,
        thursday BIT NOT NULL,
        friday BIT NOT NULL,
        saturday BIT NOT NULL,
        sunday BIT NOT NULL,
        start_date CHAR(8) NOT NULL,
        end_date CHAR(8) NOT NULL,
        CONSTRAINT PK_GtfsServiceCalendar PRIMARY KEY (agency_code, service_id),
        CONSTRAINT FK_GtfsServiceCalendar_Service FOREIGN KEY (agency_code, service_id)
            REFERENCES dbo.GtfsService (agency_code, service_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsServiceException', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsServiceException (
        agency_code NVARCHAR(10) NOT NULL,
        service_id NVARCHAR(200) NOT NULL,
        service_date CHAR(8) NOT NULL,
        exception_type TINYINT NOT NULL,
        CONSTRAINT PK_GtfsServiceException PRIMARY KEY (agency_code, service_id, service_date),
        CONSTRAINT CK_GtfsServiceException_Type CHECK (exception_type IN (1, 2)),
        CONSTRAINT FK_GtfsServiceException_Service FOREIGN KEY (agency_code, service_id)
            REFERENCES dbo.GtfsService (agency_code, service_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsShape', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsShape (
        agency_code NVARCHAR(10) NOT NULL,
        shape_id NVARCHAR(200) NOT NULL,
        CONSTRAINT PK_GtfsShape PRIMARY KEY (agency_code, shape_id),
        CONSTRAINT FK_GtfsShape_Agency FOREIGN KEY (agency_code) REFERENCES dbo.Agency (agency_code)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsShapePoint', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsShapePoint (
        agency_code NVARCHAR(10) NOT NULL,
        shape_id NVARCHAR(200) NOT NULL,
        point_sequence INT NOT NULL,
        latitude FLOAT NOT NULL,
        longitude FLOAT NOT NULL,
        CONSTRAINT PK_GtfsShapePoint PRIMARY KEY (agency_code, shape_id, point_sequence),
        CONSTRAINT FK_GtfsShapePoint_Shape FOREIGN KEY (agency_code, shape_id)
            REFERENCES dbo.GtfsShape (agency_code, shape_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsTrip', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsTrip (
        agency_code NVARCHAR(10) NOT NULL,
        trip_id NVARCHAR(200) NOT NULL,
        route_id NVARCHAR(200) NOT NULL,
        service_id NVARCHAR(200) NOT NULL,
        headsign NVARCHAR(300) NOT NULL,
        direction_id SMALLINT NULL,
        shape_id NVARCHAR(200) NULL,
        block_id NVARCHAR(100) NULL,
        brigade NVARCHAR(100) NULL,
        CONSTRAINT PK_GtfsTrip PRIMARY KEY (agency_code, trip_id),
        CONSTRAINT FK_GtfsTrip_Route FOREIGN KEY (agency_code, route_id)
            REFERENCES dbo.GtfsRoute (agency_code, route_id),
        CONSTRAINT FK_GtfsTrip_Service FOREIGN KEY (agency_code, service_id)
            REFERENCES dbo.GtfsService (agency_code, service_id),
        CONSTRAINT FK_GtfsTrip_Shape FOREIGN KEY (agency_code, shape_id)
            REFERENCES dbo.GtfsShape (agency_code, shape_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsStopTime', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GtfsStopTime (
        agency_code NVARCHAR(10) NOT NULL,
        trip_id NVARCHAR(200) NOT NULL,
        stop_sequence INT NOT NULL,
        stop_id NVARCHAR(200) NOT NULL,
        arrival_seconds INT NOT NULL,
        departure_seconds INT NOT NULL,
        CONSTRAINT PK_GtfsStopTime PRIMARY KEY (agency_code, trip_id, stop_sequence),
        CONSTRAINT FK_GtfsStopTime_Trip FOREIGN KEY (agency_code, trip_id)
            REFERENCES dbo.GtfsTrip (agency_code, trip_id),
        CONSTRAINT FK_GtfsStopTime_Stop FOREIGN KEY (agency_code, stop_id)
            REFERENCES dbo.GtfsStop (agency_code, stop_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.GtfsFeedImport', N'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_GtfsFeedImport_Agency')
BEGIN
    ALTER TABLE dbo.GtfsFeedImport
        ADD CONSTRAINT FK_GtfsFeedImport_Agency FOREIGN KEY (agency_code)
            REFERENCES dbo.Agency (agency_code);
END;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Agency WHERE agency_code = N'ztm')
    INSERT INTO dbo.Agency (agency_code, agency_name) VALUES (N'ztm', N'ZTM Rzeszów');
IF NOT EXISTS (SELECT 1 FROM dbo.Agency WHERE agency_code = N'pks')
    INSERT INTO dbo.Agency (agency_code, agency_name) VALUES (N'pks', N'PKS Rzeszów');
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_GtfsStopTime_Stop' AND object_id = OBJECT_ID(N'dbo.GtfsStopTime'))
    CREATE INDEX IX_GtfsStopTime_Stop ON dbo.GtfsStopTime (agency_code, stop_id, trip_id, stop_sequence);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_GtfsTrip_Route' AND object_id = OBJECT_ID(N'dbo.GtfsTrip'))
    CREATE INDEX IX_GtfsTrip_Route ON dbo.GtfsTrip (agency_code, route_id, service_id);
GO

IF OBJECT_ID(N'dbo.AppUser', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AppUser (
        user_id UNIQUEIDENTIFIER NOT NULL,
        email NVARCHAR(320) NOT NULL,
        display_name NVARCHAR(100) NOT NULL,
        is_admin BIT NOT NULL CONSTRAINT DF_AppUser_IsAdmin DEFAULT (0),
        created_at DATETIME2(0) NOT NULL CONSTRAINT DF_AppUser_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_AppUser PRIMARY KEY (user_id),
        CONSTRAINT UQ_AppUser_Email UNIQUE (email)
    );
END;
GO

IF OBJECT_ID(N'dbo.LocalCredential', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.LocalCredential (
        user_id UNIQUEIDENTIFIER NOT NULL,
        password_hash NVARCHAR(300) NOT NULL,
        updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_LocalCredential_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_LocalCredential PRIMARY KEY (user_id),
        CONSTRAINT FK_LocalCredential_AppUser FOREIGN KEY (user_id) REFERENCES dbo.AppUser (user_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.ExternalIdentity', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ExternalIdentity (
        provider NVARCHAR(30) NOT NULL,
        provider_subject NVARCHAR(255) NOT NULL,
        user_id UNIQUEIDENTIFIER NOT NULL,
        created_at DATETIME2(0) NOT NULL CONSTRAINT DF_ExternalIdentity_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_ExternalIdentity PRIMARY KEY (provider, provider_subject),
        CONSTRAINT FK_ExternalIdentity_AppUser FOREIGN KEY (user_id) REFERENCES dbo.AppUser (user_id),
        CONSTRAINT CK_ExternalIdentity_Provider CHECK (provider IN (N'google'))
    );
END;
GO

IF OBJECT_ID(N'dbo.AuthSession', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AuthSession (
        session_hash CHAR(64) NOT NULL,
        user_id UNIQUEIDENTIFIER NOT NULL,
        created_at DATETIME2(0) NOT NULL CONSTRAINT DF_AuthSession_CreatedAt DEFAULT (SYSUTCDATETIME()),
        expires_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_AuthSession PRIMARY KEY (session_hash),
        CONSTRAINT FK_AuthSession_AppUser FOREIGN KEY (user_id) REFERENCES dbo.AppUser (user_id)
    );
END;
GO

IF OBJECT_ID(N'dbo.OAuthState', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.OAuthState (
        state_hash CHAR(64) NOT NULL,
        provider NVARCHAR(30) NOT NULL,
        code_verifier NVARCHAR(128) NOT NULL,
        return_to NVARCHAR(2048) NOT NULL,
        expires_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_OAuthState PRIMARY KEY (state_hash),
        CONSTRAINT CK_OAuthState_Provider CHECK (provider IN (N'google'))
    );
END;
GO

IF OBJECT_ID(N'dbo.EmailChallenge', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmailChallenge (
        challenge_id UNIQUEIDENTIFIER NOT NULL,
        email NVARCHAR(320) NULL,
        purpose VARCHAR(20) NOT NULL,
        user_id UNIQUEIDENTIFIER NULL,
        code_hash CHAR(64) NOT NULL,
        created_at DATETIME2(0) NOT NULL CONSTRAINT DF_EmailChallenge_CreatedAt DEFAULT (SYSUTCDATETIME()),
        last_sent_at DATETIME2(0) NOT NULL CONSTRAINT DF_EmailChallenge_LastSentAt DEFAULT (SYSUTCDATETIME()),
        expires_at DATETIME2(0) NOT NULL,
        attempts TINYINT NOT NULL CONSTRAINT DF_EmailChallenge_Attempts DEFAULT (0),
        CONSTRAINT PK_EmailChallenge PRIMARY KEY (challenge_id),
        CONSTRAINT FK_EmailChallenge_AppUser FOREIGN KEY (user_id) REFERENCES dbo.AppUser (user_id),
        CONSTRAINT CK_EmailChallenge_Purpose CHECK (purpose IN ('verify_email', 'password_reset', 'delete_account')),
        CONSTRAINT CK_EmailChallenge_Attempts CHECK (attempts <= 5),
        CONSTRAINT CK_EmailChallenge_User CHECK (
            (purpose = 'verify_email' AND email IS NOT NULL AND user_id IS NULL)
            OR (purpose <> 'verify_email' AND email IS NULL AND user_id IS NOT NULL)
        )
    );
END;
GO

IF OBJECT_ID(N'dbo.EmailChallenge', N'U') IS NOT NULL
BEGIN
    IF EXISTS (
        SELECT 1 FROM sys.key_constraints
        WHERE name = N'UQ_EmailChallenge_EmailPurpose'
          AND parent_object_id = OBJECT_ID(N'dbo.EmailChallenge')
    )
        ALTER TABLE dbo.EmailChallenge DROP CONSTRAINT UQ_EmailChallenge_EmailPurpose;

    IF EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.EmailChallenge')
          AND name = N'email'
          AND is_nullable = 0
    )
        ALTER TABLE dbo.EmailChallenge ALTER COLUMN email NVARCHAR(320) NULL;

    IF EXISTS (
        SELECT 1 FROM sys.check_constraints
        WHERE name = N'CK_EmailChallenge_User'
          AND parent_object_id = OBJECT_ID(N'dbo.EmailChallenge')
    )
        ALTER TABLE dbo.EmailChallenge DROP CONSTRAINT CK_EmailChallenge_User;

    ALTER TABLE dbo.EmailChallenge ADD CONSTRAINT CK_EmailChallenge_User CHECK (
        (purpose = 'verify_email' AND email IS NOT NULL AND user_id IS NULL)
        OR (purpose <> 'verify_email' AND email IS NULL AND user_id IS NOT NULL)
    );

    IF NOT EXISTS (
        SELECT 1 FROM sys.check_constraints
        WHERE name = N'CK_EmailChallenge_Attempts'
          AND parent_object_id = OBJECT_ID(N'dbo.EmailChallenge')
    )
        ALTER TABLE dbo.EmailChallenge ADD CONSTRAINT CK_EmailChallenge_Attempts CHECK (attempts <= 5);
END;
GO

IF OBJECT_ID(N'dbo.PendingRegistration', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PendingRegistration (
        challenge_id UNIQUEIDENTIFIER NOT NULL,
        display_name NVARCHAR(100) NOT NULL,
        password_hash NVARCHAR(300) NOT NULL,
        CONSTRAINT PK_PendingRegistration PRIMARY KEY (challenge_id),
        CONSTRAINT FK_PendingRegistration_EmailChallenge FOREIGN KEY (challenge_id)
            REFERENCES dbo.EmailChallenge (challenge_id) ON DELETE CASCADE
    );
END;
GO

IF OBJECT_ID(N'dbo.UserFavorites', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserFavorites (
        user_id UNIQUEIDENTIFIER NOT NULL,
        favorites NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_UserFavorites_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_UserFavorites PRIMARY KEY (user_id),
        CONSTRAINT FK_UserFavorites_AppUser FOREIGN KEY (user_id)
            REFERENCES dbo.AppUser (user_id) ON DELETE CASCADE
    );
END;
GO

IF OBJECT_ID(N'dbo.FlightFare', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FlightFare (
        fare_id BIGINT IDENTITY(1,1) NOT NULL,
        airline VARCHAR(16) NOT NULL,
        from_airport CHAR(3) NOT NULL,
        to_airport CHAR(3) NOT NULL,
        flight_day DATE NOT NULL,
        departure_local VARCHAR(16) NULL,
        arrival_local VARCHAR(16) NULL,
        flight_number VARCHAR(16) NULL,
        price DECIMAL(10,2) NOT NULL,
        currency CHAR(3) NULL,
        price_pln DECIMAL(10,2) NOT NULL,
        seats_left INT NULL,
        price_type VARCHAR(8) NOT NULL,
        source VARCHAR(40) NOT NULL,
        collected_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_FlightFare PRIMARY KEY (fare_id)
    );
    CREATE INDEX IX_FlightFare_Day ON dbo.FlightFare (flight_day, from_airport, to_airport);
END;
GO

IF OBJECT_ID(N'dbo.FlightNetwork', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FlightNetwork (
        network_id TINYINT NOT NULL CONSTRAINT DF_FlightNetwork_Id DEFAULT (1),
        network NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_FlightNetwork PRIMARY KEY (network_id),
        CONSTRAINT CK_FlightNetwork_OneRow CHECK (network_id = 1)
    );
END;
GO

IF OBJECT_ID(N'dbo.AppSetting', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AppSetting (
        setting_key NVARCHAR(64) NOT NULL,
        setting_value NVARCHAR(4000) NOT NULL,
        updated_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_AppSetting PRIMARY KEY (setting_key)
    );
END;
GO

IF OBJECT_ID(N'dbo.DataSnapshot', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DataSnapshot (
        snapshot_key NVARCHAR(64) NOT NULL,
        content_type NVARCHAR(64) NOT NULL,
        etag CHAR(34) NOT NULL,
        body VARBINARY(MAX) NOT NULL,
        fetched_at DATETIME2(0) NOT NULL,
        CONSTRAINT PK_DataSnapshot PRIMARY KEY (snapshot_key)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuthSession_User' AND object_id = OBJECT_ID(N'dbo.AuthSession'))
    CREATE INDEX IX_AuthSession_User ON dbo.AuthSession (user_id, expires_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_OAuthState_Expiry' AND object_id = OBJECT_ID(N'dbo.OAuthState'))
    CREATE INDEX IX_OAuthState_Expiry ON dbo.OAuthState (expires_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailChallenge_Expiry' AND object_id = OBJECT_ID(N'dbo.EmailChallenge'))
    CREATE INDEX IX_EmailChallenge_Expiry ON dbo.EmailChallenge (expires_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_EmailChallenge_EmailPurpose' AND object_id = OBJECT_ID(N'dbo.EmailChallenge'))
    CREATE UNIQUE INDEX UX_EmailChallenge_EmailPurpose ON dbo.EmailChallenge (email, purpose) WHERE email IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_EmailChallenge_UserPurpose' AND object_id = OBJECT_ID(N'dbo.EmailChallenge'))
    CREATE UNIQUE INDEX UX_EmailChallenge_UserPurpose ON dbo.EmailChallenge (user_id, purpose) WHERE user_id IS NOT NULL;
GO

IF OBJECT_ID(N'dbo.PriceAlert', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PriceAlert (
        alert_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_PriceAlert_Id DEFAULT (NEWID()),
        user_id UNIQUEIDENTIFIER NOT NULL,
        from_airport CHAR(3) NOT NULL,
        to_airport CHAR(3) NOT NULL,
        depart_day DATE NOT NULL,
        return_day DATE NULL,
        airline VARCHAR(16) NULL,
        max_price_pln DECIMAL(10,2) NOT NULL,
        every_hours INT NOT NULL,
        label NVARCHAR(200) NULL,
        last_price_pln DECIMAL(10,2) NULL,
        last_checked_at DATETIME2(0) NULL,
        last_scan_at DATETIME2(0) NULL,
        notified_price_pln DECIMAL(10,2) NULL,
        notified_at DATETIME2(0) NULL,
        created_at DATETIME2(0) NOT NULL CONSTRAINT DF_PriceAlert_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_PriceAlert PRIMARY KEY (alert_id),
        CONSTRAINT FK_PriceAlert_AppUser FOREIGN KEY (user_id)
            REFERENCES dbo.AppUser (user_id) ON DELETE CASCADE,
        CONSTRAINT CK_PriceAlert_Every CHECK (every_hours BETWEEN 1 AND 720),
        CONSTRAINT CK_PriceAlert_Price CHECK (max_price_pln > 0)
    );
    CREATE INDEX IX_PriceAlert_User ON dbo.PriceAlert (user_id);
    CREATE INDEX IX_PriceAlert_Day ON dbo.PriceAlert (depart_day);
END;
GO

IF OBJECT_ID(N'dbo.FlightPriceHistory', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FlightPriceHistory (
        history_id BIGINT IDENTITY(1,1) NOT NULL,
        airline VARCHAR(16) NOT NULL,
        from_airport CHAR(3) NOT NULL,
        to_airport CHAR(3) NOT NULL,
        flight_day DATE NOT NULL,
        departure_local VARCHAR(16) NULL,
        arrival_local VARCHAR(16) NULL,
        flight_number VARCHAR(16) NULL,
        price DECIMAL(10,2) NOT NULL,
        currency CHAR(3) NULL,
        price_pln DECIMAL(10,2) NOT NULL,
        seats_left INT NULL,
        price_type VARCHAR(8) NOT NULL,
        source VARCHAR(40) NOT NULL,
        collected_at DATETIME2(0) NOT NULL,
        recorded_at DATETIME2(0) NOT NULL CONSTRAINT DF_FlightPriceHistory_RecordedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_FlightPriceHistory PRIMARY KEY (history_id)
    );
    CREATE INDEX IX_FlightPriceHistory_Route ON dbo.FlightPriceHistory (from_airport, to_airport, flight_day, collected_at);
END;
GO

IF OBJECT_ID(N'dbo.UserPreference', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserPreference (
        user_id UNIQUEIDENTIFIER NOT NULL,
        preferences NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_UserPreference_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_UserPreference PRIMARY KEY (user_id),
        CONSTRAINT FK_UserPreference_AppUser FOREIGN KEY (user_id) REFERENCES dbo.AppUser (user_id) ON DELETE CASCADE
    );
END;
GO
