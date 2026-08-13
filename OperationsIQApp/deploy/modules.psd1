@{
    # =========================================================================
    # Operations IQ — deployment module registry
    # -------------------------------------------------------------------------
    # The orchestrator (Deploy-All.ps1) reads this file to decide which modules
    # to run, in what order, and what each one needs/produces. Each module is an
    # independently runnable .ps1 under deploy/modules/ that:
    #   * reads its `Consumes` inputs from outputs/*.json (or env / config),
    #   * does idempotent create-or-update work,
    #   * writes its `Produces` keys back to outputs/<Id>.json.
    #
    # Fields:
    #   Id           short stable id (also the outputs/<Id>.json filename).
    #   Name         human label.
    #   Script       module script path, relative to deploy/.
    #   Tool         primary tool the module drives.
    #   RequiredRole least-privilege role the operator needs to run it.
    #   DependsOn    module ids that must run first (edges for topo-sort). A dep
    #                is considered satisfied if it ran OR its outputs already
    #                exist (so teammates can split work across permissions).
    #   Produces     output keys this module writes.
    #   Consumes     output keys this module reads.
    #   ManualDoc    doc page describing the manual alternative.
    #   Optional     $true => excluded from a default "deploy everything" run;
    #                must be named explicitly via -Modules.
    #   Description  one-liner.
    # =========================================================================
    Modules = @(
        @{
            Id           = 'preflight'
            Name         = 'M0 Preflight'
            Script       = 'modules/Invoke-Preflight.ps1'
            Tool         = 'powershell'
            RequiredRole = 'none'
            DependsOn    = @()
            Produces     = @('preflightOk')
            Consumes     = @()
            ManualDoc    = 'admin/deploy/preflight'
            Optional     = $false
            Description  = 'Verify required CLIs (az, terraform, python, node, rayfin) and login state.'
        },
        @{
            Id           = 'foundry'
            Name         = 'M1a Azure AI Foundry'
            Script       = 'modules/Invoke-Foundry.ps1'
            Tool         = 'terraform'
            RequiredRole = 'Azure subscription Contributor + Cognitive Services Contributor'
            DependsOn    = @('preflight')
            Produces     = @('foundryEndpoint', 'foundryModelDeployment', 'foundryProjectName')
            Consumes     = @()
            ManualDoc    = 'admin/deploy/foundry'
            Optional     = $false
            Description  = 'Provision the Foundry account, project, and chat model deployment (Terraform).'
        },
        @{
            Id           = 'entra'
            Name         = 'M1b Entra MSAL SPA app'
            Script       = 'modules/Invoke-Entra.ps1'
            Tool         = 'terraform'
            RequiredRole = 'Entra Application Administrator (+ admin consent)'
            DependsOn    = @('preflight')
            Produces     = @('msalClientId', 'tenantId')
            Consumes     = @('appOrigin')
            ManualDoc    = 'admin/entra-app-registration'
            Optional     = $false
            Description  = 'Create the SPA app registration for Kusto-audience tokens; redirect URIs + ADX permission + consent.'
        },
        @{
            Id           = 'deploy-sp'
            Name         = 'M1c Deployment service principal'
            Script       = 'modules/Invoke-DeploySp.ps1'
            Tool         = 'terraform'
            RequiredRole = 'Entra Application Administrator'
            DependsOn    = @('preflight')
            Produces     = @('deploySpClientId')
            Consumes     = @()
            ManualDoc    = 'admin/deploy/deploy-sp'
            Optional     = $true
            Description  = 'Optional: create a CI/hand-off service principal with the roles the pipeline needs.'
        },
        @{
            Id           = 'lakehouse'
            Name         = 'M2a Fabric Lakehouse'
            Script       = 'modules/Invoke-Lakehouse.ps1'
            Tool         = 'fabric-cicd'
            RequiredRole = 'Fabric Workspace Admin/Member'
            DependsOn    = @('preflight')
            Produces     = @('lakehouseId', 'workspaceId')
            Consumes     = @('workspaceId')
            ManualDoc    = 'admin/deploy/fabric-items'
            Optional     = $false
            Description  = 'Publish the Lakehouse that runs the Livy/Spark pattern analyses (fabric-cicd).'
        },
        @{
            Id           = 'spark-job'
            Name         = 'M2b Spark Job Definition'
            Script       = 'modules/Invoke-SparkJob.ps1'
            Tool         = 'fabric-cicd'
            RequiredRole = 'Fabric Workspace Member'
            DependsOn    = @('lakehouse')
            Produces     = @('sparkJobDefId')
            Consumes     = @('workspaceId')
            ManualDoc    = 'admin/deploy/fabric-items'
            Optional     = $true
            Description  = 'Optional headless Spark Job Definition (the SPA inlines tsmp into Livy, so this is opt-in).'
        },
        @{
            Id           = 'eventhouse-new'
            Name         = 'M2c New Eventhouse + KQL DB (sample)'
            Script       = 'modules/Invoke-EventhouseNew.ps1'
            Tool         = 'fabric-cicd + REST'
            RequiredRole = 'Fabric Workspace Member'
            DependsOn    = @('preflight')
            Produces     = @('eventhouseId', 'clusterUri', 'kqlDatabaseId', 'sampleDatabaseName')
            Consumes     = @('workspaceId')
            ManualDoc    = 'admin/deploy/fabric-items'
            Optional     = $true
            Description  = 'Optional: provision a NEW Eventhouse + KQL DB to hold seeded sample data (demo/trial).'
        },
        @{
            Id           = 'app-backend'
            Name         = 'M3 Fabric App backend (RayFin)'
            Script       = 'modules/Invoke-AppBackend.ps1'
            Tool         = 'rayfin (REST fallback)'
            RequiredRole = 'Fabric Workspace Member'
            DependsOn    = @('preflight')
            Produces     = @('fabricItemId', 'appOrigin', 'rayfinApiUrl', 'rayfinPublishableKey', 'workspaceId')
            Consumes     = @('workspaceId', 'appOrigin')
            ManualDoc    = 'admin/rayfin-backend'
            Optional     = $false
            Description  = 'Provision the Fabric App control plane (SQL + GraphQL + hosting) and apply the entity schema.'
        },
        @{
            Id           = 'eventhouse'
            Name         = 'M4 Eventhouse enablement + seed + profile'
            Script       = 'modules/Invoke-EventhouseEnable.ps1'
            Tool         = 'powershell (az rest) + node'
            RequiredRole = 'KQL DB Admin (retrofit) / Ingestor (seed)'
            DependsOn    = @('preflight')
            Produces     = @('companionDatabase', 'eventhouseQueryUri', 'connectionProfileId')
            Consumes     = @('workspaceId', 'eventhouseId', 'clusterUri', 'rayfinApiUrl', 'rayfinPublishableKey')
            ManualDoc    = 'admin/eventhouse-deployment'
            Optional     = $false
            Description  = 'Retrofit (or use the new) Eventhouse: deploy schema, optionally seed sample data, and create a connection profile.'
        },
        @{
            Id           = 'agent'
            Name         = 'M5 Foundry agent'
            Script       = 'modules/Invoke-Agent.ps1'
            Tool         = 'node (agent:provision)'
            RequiredRole = 'Foundry project data scientist'
            DependsOn    = @('foundry')
            Produces     = @('agentName', 'agentVersion')
            Consumes     = @('foundryEndpoint', 'foundryModelDeployment')
            ManualDoc    = 'admin/deploy/agent'
            Optional     = $false
            Description  = 'Create/version the Operations Advisor agent in the Foundry project.'
        },
        @{
            Id           = 'config'
            Name         = 'M6 Config assembly + build/publish'
            Script       = 'modules/Invoke-Config.ps1'
            Tool         = 'powershell + rayfin'
            RequiredRole = 'Fabric Workspace Member'
            DependsOn    = @('app-backend', 'eventhouse', 'entra')
            Produces     = @('envFile', 'published')
            Consumes     = @(
                'rayfinApiUrl', 'rayfinPublishableKey', 'workspaceId', 'fabricItemId',
                'eventhouseQueryUri', 'companionDatabase', 'msalClientId', 'tenantId',
                'foundryEndpoint', 'agentName', 'lakehouseId'
            )
            ManualDoc    = 'admin/configuration'
            Optional     = $false
            Description  = 'Assemble .env.production from all module outputs, then build + publish the SPA.'
        },
        @{
            Id           = 'smoke'
            Name         = 'M7 Smoke validation'
            Script       = 'modules/Invoke-Smoke.ps1'
            Tool         = 'powershell'
            RequiredRole = 'user read access'
            DependsOn    = @('config')
            Produces     = @('smokeOk')
            Consumes     = @('eventhouseQueryUri', 'companionDatabase', 'appOrigin', 'foundryEndpoint')
            ManualDoc    = 'admin/deploy/smoke'
            Optional     = $false
            Description  = 'Headless post-deploy checks: schema present, SPA reachable, sample query, agent reachable.'
        }
    )
}
