# SmokeForge — Enterprise E2E Validation Strategy
## Production-Grade Repos + Accuracy Validation for Real-World Smoke Test Generation

---

> **Purpose:** This document specifies how to build enterprise-scale test repositories
> for each framework, and exactly how to validate that SmokeForge generates correct,
> accurate, executable smoke tests from them — including auth flows, request bodies,
> path parameters, query parameters, and UI locators.
>
> **Philosophy:** If SmokeForge cannot generate a passing smoke test suite for these
> repos, it is not production-ready. These repos ARE the bar.

---

## TABLE OF CONTENTS

1. What Makes a Repo "Enterprise Grade" for Testing
2. Enterprise Repo Specifications (Per Framework)
3. Auth Pattern Matrix (Every Auth Type to Cover)
4. Validation Framework — How to Measure Correctness
5. Endpoint Accuracy Validator
6. Request Body Accuracy Validator
7. Auth Flow Validator
8. UI Locator Accuracy Validator
9. End-to-End Validation Pipeline
10. Acceptance Criteria Per Category
11. Implementation Order

---

## SECTION 1 — WHAT MAKES A REPO "ENTERPRISE GRADE"

A production enterprise repo for validation purposes must have:

### Scale
- Minimum 40 API endpoints across at least 6 business domains
- Minimum 10 UI pages (for full-stack repos)
- At least 3 levels of route nesting
- At least 2 API versions

### Auth Complexity
- A real authentication flow (not a stub) — the app must actually reject requests without valid credentials
- At least one SSO pattern OR OAuth2 pattern OR multi-tenant JWT
- Role-based access control with at least 3 roles
- Both public and private endpoints in the same router

### Schema Complexity
- Required fields, optional fields, nested objects, arrays
- Field-level validators (email, uuid, min/max, regex, enum)
- At least one DTO that references another DTO (nested validation)
- At least one endpoint where request body schema differs by role

### Infrastructure
- Real in-memory database (not mocked) — SQLite via better-sqlite3 or Prisma + SQLite
- Real JWT signing/verification (jsonwebtoken with actual secret)
- Real bcrypt password hashing
- Seeds: pre-created admin user, regular user, test data
- Single command startup: `pnpm dev` or `node dist/server.js`
- Single command seed: `pnpm seed`
- Health check endpoint: GET /health returns 200

### Documentation
- `VALIDATION_MANIFEST.json` — the ground truth document
  (every endpoint, every parameter, every schema field, every auth rule)
- `SEED_CREDENTIALS.json` — test credentials that work after seeding
- `API_GUIDE.md` — human-readable description of the API

---

## SECTION 2 — ENTERPRISE REPO SPECIFICATIONS

---

### REPO 1: Express.js — HR Management Platform

**Name:** `enterprise-express-hr`
**Stack:** Express.js + TypeScript + Zod + JWT + SQLite (better-sqlite3)
**Auth:** JWT Bearer with role-based access (admin, hr_manager, employee, viewer)
**Domain:** Human Resources — Employees, Departments, Leave Requests, Payroll, Performance Reviews

#### Full Route Map (45 endpoints)

```
PUBLIC (no auth):
  POST /api/v1/auth/login                    body: { email, password }
  POST /api/v1/auth/register                 body: { email, password, firstName, lastName, inviteCode }
  POST /api/v1/auth/refresh                  body: { refreshToken }
  POST /api/v1/auth/forgot-password          body: { email }
  POST /api/v1/auth/reset-password           body: { token, password, confirmPassword }
  GET  /api/v1/auth/verify-email             query: { token }
  GET  /health

EMPLOYEES — auth required, role: any:
  GET    /api/v1/employees                   query: { page, limit, search, departmentId, status, sortBy, sortOrder }
  POST   /api/v1/employees                   body: { firstName, lastName, email, departmentId, jobTitle, startDate, salary, employmentType }  role: admin|hr_manager
  GET    /api/v1/employees/:employeeId        path: { employeeId: uuid }
  PATCH  /api/v1/employees/:employeeId        body: { firstName?, lastName?, jobTitle?, departmentId?, salary? }  role: admin|hr_manager
  DELETE /api/v1/employees/:employeeId        path: { employeeId: uuid }  role: admin
  GET    /api/v1/employees/:employeeId/profile
  PUT    /api/v1/employees/:employeeId/profile  body: { phone?, address?, emergencyContact?, bio? }
  POST   /api/v1/employees/:employeeId/avatar   multipart: { avatar: File }
  GET    /api/v1/employees/:employeeId/documents
  POST   /api/v1/employees/:employeeId/documents  body: { name, type, url }  role: admin|hr_manager
  GET    /api/v1/employees/me                (current authenticated user's profile)

DEPARTMENTS — role: any read, admin|hr_manager write:
  GET    /api/v1/departments                 query: { page, limit, search }
  POST   /api/v1/departments                 body: { name, description, managerId, budget }  role: admin
  GET    /api/v1/departments/:departmentId
  PATCH  /api/v1/departments/:departmentId   body: { name?, description?, managerId?, budget? }  role: admin
  DELETE /api/v1/departments/:departmentId   role: admin
  GET    /api/v1/departments/:departmentId/employees  query: { page, limit }

LEAVE REQUESTS:
  GET    /api/v1/leave-requests              query: { page, limit, status, employeeId, dateFrom, dateTo }
  POST   /api/v1/leave-requests              body: { type, startDate, endDate, reason }
  GET    /api/v1/leave-requests/:requestId
  PATCH  /api/v1/leave-requests/:requestId/approve   body: { comments? }  role: admin|hr_manager
  PATCH  /api/v1/leave-requests/:requestId/reject    body: { reason }  role: admin|hr_manager
  DELETE /api/v1/leave-requests/:requestId   (cancel — only owner or admin)

PAYROLL — role: admin|hr_manager:
  GET    /api/v1/payroll                     query: { month, year, departmentId }
  POST   /api/v1/payroll/run                 body: { month, year, departmentIds? }  role: admin
  GET    /api/v1/payroll/:payrollId
  GET    /api/v1/payroll/:payrollId/payslips
  GET    /api/v1/payroll/employees/:employeeId/history  query: { year }
  POST   /api/v1/payroll/employees/:employeeId/bonus    body: { amount, reason, date }  role: admin

PERFORMANCE:
  GET    /api/v1/performance/reviews         query: { employeeId, cycle, status }
  POST   /api/v1/performance/reviews         body: { employeeId, cycle, goals, selfRating, managerRating, comments }  role: admin|hr_manager
  GET    /api/v1/performance/reviews/:reviewId
  PATCH  /api/v1/performance/reviews/:reviewId  body: { goals?, selfRating?, managerRating?, comments?, status? }
  GET    /api/v1/performance/cycles          query: { year }

ADMIN ONLY:
  GET    /api/v1/admin/audit-logs            query: { page, limit, userId, action, resource, dateFrom, dateTo }
  GET    /api/v1/admin/system-stats
  GET    /api/v1/admin/users                 query: { page, limit, role, isActive }
  PATCH  /api/v1/admin/users/:userId/role    body: { role }
  POST   /api/v1/admin/bulk-import/employees body: { csvData, sendWelcomeEmail }

V2 (enhanced responses):
  GET    /api/v2/employees                   query: { cursor, limit, include[] }
  GET    /api/v2/employees/:employeeId       query: { include[] }  (embedded relations)
```

#### Zod Schema Definitions (Full)

```typescript
// These must be defined in the repo — SmokeForge must extract them

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const CreateEmployeeSchema = z.object({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email(),
  departmentId: z.string().uuid(),
  jobTitle: z.string().min(1).max(100),
  startDate: z.string().datetime(),
  salary: z.number().positive().max(1000000),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern'])
});

export const CreateLeaveRequestSchema = z.object({
  type: z.enum(['annual', 'sick', 'parental', 'unpaid', 'bereavement']),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  reason: z.string().min(10).max(500)
});

export const RunPayrollSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
  departmentIds: z.array(z.string().uuid()).optional()
});

// ... (all schemas for all 45 endpoints)
```

#### Auth Architecture

```typescript
// JWT with 2 tokens (access + refresh)
// Access token: 1 hour expiry
// Refresh token: 30 days expiry
// Roles embedded in JWT payload: { userId, email, role, departmentId }
// Role hierarchy: admin > hr_manager > employee > viewer

// Middleware chain:
// authenticate → decodes JWT, attaches req.user
// requireRole(['admin', 'hr_manager']) → checks role
// requireSelf(paramName) → checks if req.user.id === req.params[paramName]

// Seed file creates:
// admin@hr-enterprise.test / AdminPass123!  (role: admin)
// manager@hr-enterprise.test / ManagerPass123! (role: hr_manager)
// employee@hr-enterprise.test / EmployeePass123! (role: employee)
// viewer@hr-enterprise.test / ViewerPass123! (role: viewer)
```

#### VALIDATION_MANIFEST.json Structure

```json
{
  "repo": "enterprise-express-hr",
  "framework": "express",
  "version": "1.0.0",
  "baseUrl": "http://localhost:3001",
  "auth": {
    "type": "bearer_jwt",
    "loginEndpoint": "POST /api/v1/auth/login",
    "credentialsFields": { "email": "email", "password": "password" },
    "tokenResponsePath": "accessToken",
    "tokenHeaderName": "Authorization",
    "tokenHeaderFormat": "Bearer {token}",
    "roles": {
      "admin":      { "email": "admin@hr-enterprise.test",    "password": "AdminPass123!" },
      "hr_manager": { "email": "manager@hr-enterprise.test",  "password": "ManagerPass123!" },
      "employee":   { "email": "employee@hr-enterprise.test", "password": "EmployeePass123!" },
      "viewer":     { "email": "viewer@hr-enterprise.test",   "password": "ViewerPass123!" }
    },
    "refreshEndpoint": "POST /api/v1/auth/refresh",
    "refreshTokenField": "refreshToken"
  },
  "endpoints": [
    {
      "id": "ep_login",
      "method": "POST",
      "path": "/api/v1/auth/login",
      "authRequired": false,
      "requestBody": {
        "fields": [
          { "name": "email", "type": "string", "format": "email", "required": true, "example": "admin@hr-enterprise.test" },
          { "name": "password", "type": "string", "minLength": 8, "required": true, "example": "AdminPass123!" }
        ]
      },
      "expectedResponse": {
        "status": 200,
        "bodyContains": ["accessToken", "refreshToken", "expiresIn", "user"]
      }
    },
    {
      "id": "ep_list_employees",
      "method": "GET",
      "path": "/api/v1/employees",
      "authRequired": true,
      "minRole": "viewer",
      "queryParams": [
        { "name": "page", "type": "number", "required": false, "default": 1, "example": 1 },
        { "name": "limit", "type": "number", "required": false, "default": 20, "example": 20 },
        { "name": "search", "type": "string", "required": false, "example": "John" },
        { "name": "departmentId", "type": "string", "format": "uuid", "required": false },
        { "name": "status", "type": "enum", "values": ["active", "inactive", "on_leave"], "required": false },
        { "name": "sortBy", "type": "enum", "values": ["createdAt", "firstName", "lastName", "salary"], "required": false, "default": "createdAt" },
        { "name": "sortOrder", "type": "enum", "values": ["asc", "desc"], "required": false, "default": "desc" }
      ],
      "requestBody": null,
      "expectedResponse": {
        "status": 200,
        "bodyContains": ["data", "meta"],
        "metaContains": ["page", "limit", "total", "totalPages"]
      }
    },
    {
      "id": "ep_create_employee",
      "method": "POST",
      "path": "/api/v1/employees",
      "authRequired": true,
      "requiredRoles": ["admin", "hr_manager"],
      "requestBody": {
        "fields": [
          { "name": "firstName", "type": "string", "minLength": 1, "maxLength": 50, "required": true, "example": "Jane" },
          { "name": "lastName", "type": "string", "minLength": 1, "maxLength": 50, "required": true, "example": "Smith" },
          { "name": "email", "type": "string", "format": "email", "required": true, "example": "jane.smith@example.com" },
          { "name": "departmentId", "type": "string", "format": "uuid", "required": true, "example": "{{SEED_DEPARTMENT_ID}}" },
          { "name": "jobTitle", "type": "string", "required": true, "example": "Software Engineer" },
          { "name": "startDate", "type": "string", "format": "date-time", "required": true, "example": "2024-01-15T00:00:00.000Z" },
          { "name": "salary", "type": "number", "min": 0, "max": 1000000, "required": true, "example": 75000 },
          { "name": "employmentType", "type": "enum", "values": ["full_time", "part_time", "contract", "intern"], "required": true, "example": "full_time" }
        ]
      },
      "expectedResponse": {
        "status": 201,
        "bodyContains": ["data"],
        "dataContains": ["id", "firstName", "lastName", "email"]
      },
      "roleAccessMatrix": {
        "admin":      { "expectedStatus": 201 },
        "hr_manager": { "expectedStatus": 201 },
        "employee":   { "expectedStatus": 403 },
        "viewer":     { "expectedStatus": 403 }
      }
    }
  ]
}
```

---

### REPO 2: NestJS — E-Commerce Platform

**Name:** `enterprise-nestjs-ecommerce`
**Stack:** NestJS + TypeScript + class-validator + Passport JWT + Prisma + SQLite
**Auth:** Passport JWT + Role Guards + API Key for webhook endpoints
**Domain:** E-Commerce — Catalog, Orders, Customers, Inventory, Promotions, Analytics

#### Full Route Map (52 endpoints)

```
AUTH:
  POST /api/auth/register           ← @Public()
  POST /api/auth/login              ← @Public()
  POST /api/auth/refresh            ← @Public()
  POST /api/auth/logout             ← @UseGuards(JwtAuthGuard)
  GET  /api/auth/profile            ← @UseGuards(JwtAuthGuard)
  POST /api/auth/change-password    ← @UseGuards(JwtAuthGuard)

CATALOG — @Controller('catalog'):
  GET    /api/catalog/products              ← @Public()
  POST   /api/catalog/products              ← @Roles('admin', 'catalog_manager')
  GET    /api/catalog/products/:productId   ← @Public()
  PUT    /api/catalog/products/:productId   ← @Roles('admin', 'catalog_manager')
  DELETE /api/catalog/products/:productId   ← @Roles('admin')
  GET    /api/catalog/categories            ← @Public()
  POST   /api/catalog/categories            ← @Roles('admin')
  GET    /api/catalog/categories/:categoryId  ← @Public()
  PATCH  /api/catalog/categories/:categoryId  ← @Roles('admin')
  GET    /api/catalog/brands                ← @Public()
  POST   /api/catalog/brands                ← @Roles('admin')
  POST   /api/catalog/products/:productId/variants  ← @Roles('admin', 'catalog_manager')
  DELETE /api/catalog/products/:productId/variants/:variantId  ← @Roles('admin')
  POST   /api/catalog/products/:productId/images  ← @Roles('admin', 'catalog_manager')

ORDERS — @Controller('orders'):
  GET    /api/orders                        ← admin sees all, customer sees own
  POST   /api/orders                        ← customer places order
  GET    /api/orders/:orderId
  PATCH  /api/orders/:orderId/status        ← @Roles('admin', 'fulfillment')
  POST   /api/orders/:orderId/cancel
  POST   /api/orders/:orderId/refund        ← @Roles('admin')
  GET    /api/orders/:orderId/tracking
  GET    /api/orders/:orderId/invoice

CUSTOMERS — @Controller('customers'):
  GET    /api/customers                     ← @Roles('admin', 'support')
  GET    /api/customers/:customerId
  PATCH  /api/customers/:customerId
  DELETE /api/customers/:customerId         ← @Roles('admin')
  GET    /api/customers/:customerId/orders  query: { page, limit, status }
  GET    /api/customers/:customerId/addresses
  POST   /api/customers/:customerId/addresses  body: address object
  DELETE /api/customers/:customerId/addresses/:addressId

INVENTORY — @Controller('inventory'):
  GET    /api/inventory                     ← @Roles('admin', 'inventory_manager')
  GET    /api/inventory/:variantId
  PATCH  /api/inventory/:variantId          body: { quantity, reason, notes }
  POST   /api/inventory/bulk-adjust         body: { adjustments: [{variantId, quantity, reason}] }
  GET    /api/inventory/alerts              ← low stock alerts

PROMOTIONS — @Controller('promotions'):
  GET    /api/promotions                    ← @Public() (returns active promos)
  POST   /api/promotions                    ← @Roles('admin', 'marketing')
  GET    /api/promotions/:promoId
  PATCH  /api/promotions/:promoId           ← @Roles('admin', 'marketing')
  DELETE /api/promotions/:promoId           ← @Roles('admin')
  POST   /api/promotions/validate           body: { code, cartTotal, customerId }  ← @Public()

ANALYTICS — @Controller('analytics'):
  GET    /api/analytics/dashboard           ← @Roles('admin')  query: { period }
  GET    /api/analytics/revenue             ← @Roles('admin')  query: { dateFrom, dateTo, granularity }
  GET    /api/analytics/top-products        ← @Roles('admin')  query: { limit, period }
  GET    /api/analytics/customer-cohorts    ← @Roles('admin')

WEBHOOKS — @Controller('webhooks'):
  POST   /api/webhooks/payment/stripe       ← API key auth (x-stripe-signature header)
  POST   /api/webhooks/payment/paypal       ← API key auth
  POST   /api/webhooks/shipping/fedex       ← API key auth (x-webhook-secret)
```

#### NestJS DTO Specifications

```typescript
// All DTOs must use class-validator — SmokeForge must extract them

export class CreateProductDto {
  @IsString() @MinLength(1) @MaxLength(255)
  name: string;

  @IsString() @Matches(/^[a-z0-9-]+$/)
  slug: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsUUID('4')
  categoryId: string;

  @IsOptional() @IsUUID('4')
  brandId?: string;

  @IsEnum(ProductStatus)
  status: ProductStatus;

  @IsNumber() @IsPositive()
  basePrice: number;

  @IsOptional() @IsNumber() @IsPositive()
  compareAtPrice?: number;

  @IsArray() @IsString({ each: true }) @MaxLength(20)
  tags: string[];

  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  @ArrayMinSize(1)
  variants: CreateVariantDto[];

  @IsOptional() @ValidateNested()
  @Type(() => ProductSeoDto)
  seo?: ProductSeoDto;
}

export class CreateVariantDto {
  @IsString() @MaxLength(100)
  sku: string;

  @IsString() @MaxLength(255)
  name: string;

  @IsNumber() @IsPositive()
  price: number;

  @IsInt() @Min(0)
  inventory: number;

  @IsOptional() @IsNumber() @IsPositive()
  weight?: number;

  @IsOptional() @IsObject()
  attributes?: Record<string, string>;
}

export class PlaceOrderDto {
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress: AddressDto;

  @IsOptional() @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto;

  @IsString()
  paymentMethodId: string;

  @IsOptional() @IsString() @MaxLength(20)
  couponCode?: string;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string;
}
```

#### Auth Architecture — Passport + Multi-Role + API Key

```typescript
// Roles: admin, catalog_manager, fulfillment, inventory_manager, marketing, support, customer

// JwtAuthGuard — standard bearer token
// RolesGuard — checks JWT payload roles
// ApiKeyGuard — for webhook endpoints only (x-webhook-secret header)

// @Public() decorator skips JwtAuthGuard globally
// @Roles(...) activates RolesGuard for that endpoint

// Webhook auth: different auth type entirely
// Request has: POST /api/webhooks/payment/stripe
// Header: x-stripe-signature: sha256=<hmac>
// SmokeForge must detect this as api_key_header auth type
// with different validation than JWT routes

// Seeds:
// superadmin@ecommerce.test / SuperAdmin123! (role: admin)
// catalog@ecommerce.test / Catalog123! (role: catalog_manager)
// fulfillment@ecommerce.test / Fulfillment123! (role: fulfillment)
// customer@ecommerce.test / Customer123! (role: customer)
// WEBHOOK_SECRET=test-webhook-secret-key-for-smoke-testing
```

---

### REPO 3: Next.js App Router — SaaS Project Management

**Name:** `enterprise-nextjs-saas`
**Stack:** Next.js 14 App Router + Prisma + NextAuth.js (OAuth Google + credentials) + Zod
**Auth:** NextAuth with Google OAuth AND credentials provider, session-based, middleware protection
**Domain:** SaaS Project Management — Workspaces, Projects, Tasks, Members, Comments, Files

#### This Repo Tests: SSO Authentication Flow

```typescript
// NextAuth configuration:
// Provider 1: Google OAuth (SSO)
// Provider 2: Credentials (email + password fallback)
//
// Session stored in JWT (not database sessions)
// Middleware protects all /api/* and /dashboard/* routes
// Public routes: /, /auth/login, /auth/register, /api/auth/**
//
// CRITICAL for SmokeForge: Must detect NextAuth as auth type
// Must generate a login test that handles:
//   1. Credentials login via POST /api/auth/callback/credentials
//   2. Session cookie extraction
//   3. Subsequent requests use session cookie, NOT bearer token

// middleware.ts:
export const config = {
  matcher: ['/dashboard/:path*', '/api/projects/:path*', '/api/workspaces/:path*',
            '/api/members/:path*', '/api/tasks/:path*']
}
```

#### Full Route Map (48 API endpoints + 12 pages)

```
API ROUTES (all under /app/api/):

AUTH (NextAuth handles these — SmokeForge must detect them):
  POST /api/auth/callback/credentials    ← NextAuth credentials login
  GET  /api/auth/session                 ← get current session
  POST /api/auth/signout                 ← logout

WORKSPACES:
  GET    /api/workspaces                 ← list user's workspaces
  POST   /api/workspaces                 body: { name, slug, plan }
  GET    /api/workspaces/[workspaceId]
  PATCH  /api/workspaces/[workspaceId]   body: { name?, settings? }
  DELETE /api/workspaces/[workspaceId]   ← owner only
  GET    /api/workspaces/[workspaceId]/members
  POST   /api/workspaces/[workspaceId]/members/invite  body: { email, role }
  DELETE /api/workspaces/[workspaceId]/members/[memberId]
  PATCH  /api/workspaces/[workspaceId]/members/[memberId]  body: { role }

PROJECTS:
  GET    /api/workspaces/[workspaceId]/projects
  POST   /api/workspaces/[workspaceId]/projects  body: { name, description, status, startDate, endDate }
  GET    /api/workspaces/[workspaceId]/projects/[projectId]
  PATCH  /api/workspaces/[workspaceId]/projects/[projectId]
  DELETE /api/workspaces/[workspaceId]/projects/[projectId]
  GET    /api/workspaces/[workspaceId]/projects/[projectId]/stats

TASKS:
  GET    /api/workspaces/[workspaceId]/projects/[projectId]/tasks  query: { status, assigneeId, priority, page, limit }
  POST   /api/workspaces/[workspaceId]/projects/[projectId]/tasks  body: { title, description, status, priority, assigneeId, dueDate, labels[] }
  GET    /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]
  PATCH  /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]
  DELETE /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]
  PATCH  /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/assign  body: { assigneeId }
  PATCH  /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/status  body: { status }

COMMENTS:
  GET    /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/comments
  POST   /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/comments  body: { content, mentions[] }
  PATCH  /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]
  DELETE /api/workspaces/[workspaceId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]

FILES:
  GET    /api/workspaces/[workspaceId]/files            query: { projectId?, taskId?, page }
  POST   /api/workspaces/[workspaceId]/files            multipart: { file, projectId?, taskId? }
  DELETE /api/workspaces/[workspaceId]/files/[fileId]
  GET    /api/workspaces/[workspaceId]/files/[fileId]/download

MEMBERS (workspace-level):
  GET    /api/workspaces/[workspaceId]/members/me       ← current user's membership details

NOTIFICATIONS:
  GET    /api/notifications                              query: { unreadOnly, page }
  PATCH  /api/notifications/[notificationId]/read
  POST   /api/notifications/mark-all-read

SEARCH:
  GET    /api/search                                     query: { q, workspaceId, types[] }

UI PAGES (all under /app/):
  /                                                      ← landing page (public)
  /auth/login                                            ← login form (public)
  /auth/register                                         ← register form (public)
  /dashboard                                             ← workspace selector (auth required)
  /dashboard/[workspaceId]                               ← workspace home
  /dashboard/[workspaceId]/projects                      ← project list
  /dashboard/[workspaceId]/projects/[projectId]          ← project board
  /dashboard/[workspaceId]/projects/[projectId]/tasks/[taskId]  ← task detail
  /dashboard/[workspaceId]/members                       ← member management
  /dashboard/[workspaceId]/settings                      ← workspace settings
  /settings/profile                                      ← user profile
  /settings/billing                                      ← subscription settings
```

#### UI Component Locator Requirements

```
These locators MUST be extractable by SmokeForge:

LoginPage (/auth/login):
  - data-testid="email-input"             ← email field
  - data-testid="password-input"          ← password field
  - data-testid="login-submit"            ← submit button
  - data-testid="google-login-btn"        ← Google OAuth button
  - data-testid="forgot-password-link"    ← link to reset

WorkspaceDashboard (/dashboard/[workspaceId]):
  - data-testid="create-project-btn"
  - data-testid="workspace-name"
  - aria-label="Project list"
  - data-testid="project-card-{projectId}" ← dynamic

ProjectBoard (/dashboard/[workspaceId]/projects/[projectId]):
  - data-testid="add-task-btn"
  - data-testid="task-status-filter"
  - aria-label="Task board"
  - data-testid="task-card-{taskId}"       ← dynamic
  - data-testid="sprint-selector"

TaskDetail:
  - data-testid="task-title"
  - data-testid="task-description"
  - data-testid="assignee-selector"
  - data-testid="priority-selector"
  - data-testid="due-date-picker"
  - data-testid="add-comment-input"
  - data-testid="submit-comment-btn"
  - data-testid="task-status-dropdown"
```

---

### REPO 4: tRPC + Next.js — Financial Dashboard

**Name:** `enterprise-trpc-finance`
**Stack:** Next.js 14 + tRPC v10 + Zod + better-auth + Prisma + SQLite
**Auth:** better-auth with session management, multi-tenant (organization-based)
**Domain:** Financial — Accounts, Transactions, Budgets, Reports, Alerts

#### tRPC Router Structure

```typescript
// SmokeForge must detect these as HTTP endpoints via tRPC HTTP adapter

export const appRouter = router({
  auth: router({
    login: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string() }))
      .mutation(async ({ input }) => { ... }),
    // → POST /api/trpc/auth.login

    logout: protectedProcedure.mutation(async ({ ctx }) => { ... }),
    // → POST /api/trpc/auth.logout

    me: protectedProcedure.query(async ({ ctx }) => { ... }),
    // → GET /api/trpc/auth.me
  }),

  accounts: router({
    list: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid() }))
      .query(async ({ input, ctx }) => { ... }),
    // → GET /api/trpc/accounts.list?input=...

    getById: protectedProcedure
      .input(z.object({ accountId: z.string().uuid() }))
      .query(async ({ input, ctx }) => { ... }),
    // → GET /api/trpc/accounts.getById?input=...

    create: managerProcedure
      .input(z.object({
        name: z.string().min(1),
        type: z.enum(['checking', 'savings', 'investment', 'credit']),
        currency: z.string().length(3),
        organizationId: z.string().uuid(),
        initialBalance: z.number().optional()
      }))
      .mutation(async ({ input, ctx }) => { ... }),
    // → POST /api/trpc/accounts.create

    update: managerProcedure
      .input(z.object({ accountId: z.string().uuid(), name: z.string().optional() }))
      .mutation(async ({ input, ctx }) => { ... }),

    delete: adminProcedure
      .input(z.object({ accountId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => { ... }),
  }),

  transactions: router({
    list: protectedProcedure
      .input(z.object({
        accountId: z.string().uuid(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
        type: z.enum(['income', 'expense', 'transfer']).optional(),
        category: z.string().optional(),
        minAmount: z.number().optional(),
        maxAmount: z.number().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20)
      }))
      .query(async ({ input }) => { ... }),

    create: protectedProcedure
      .input(z.object({
        accountId: z.string().uuid(),
        type: z.enum(['income', 'expense', 'transfer']),
        amount: z.number().positive(),
        currency: z.string().length(3),
        description: z.string().min(1).max(255),
        category: z.string().min(1),
        date: z.string().datetime(),
        tags: z.array(z.string()).optional(),
        toAccountId: z.string().uuid().optional() // for transfers
      }))
      .mutation(async ({ input, ctx }) => { ... }),

    update: protectedProcedure
      .input(z.object({
        transactionId: z.string().uuid(),
        description: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional()
      }))
      .mutation(async ({ input, ctx }) => { ... }),

    delete: managerProcedure
      .input(z.object({ transactionId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => { ... }),

    import: managerProcedure
      .input(z.object({
        accountId: z.string().uuid(),
        format: z.enum(['csv', 'ofx', 'qif']),
        data: z.string() // base64 encoded file
      }))
      .mutation(async ({ input, ctx }) => { ... }),
  }),

  budgets: router({
    list: protectedProcedure.input(z.object({ organizationId: z.string().uuid() })).query(...),
    create: managerProcedure.input(z.object({
      name: z.string(),
      amount: z.number().positive(),
      period: z.enum(['monthly', 'quarterly', 'yearly']),
      category: z.string(),
      organizationId: z.string().uuid(),
      alertThreshold: z.number().min(0).max(100).optional()
    })).mutation(...),
    update: managerProcedure.input(...).mutation(...),
    delete: adminProcedure.input(z.object({ budgetId: z.string().uuid() })).mutation(...),
    getSpending: protectedProcedure.input(z.object({ budgetId: z.string().uuid(), period: z.string() })).query(...),
  }),

  reports: router({
    cashFlow: protectedProcedure.input(z.object({
      organizationId: z.string().uuid(),
      dateFrom: z.string().datetime(),
      dateTo: z.string().datetime(),
      granularity: z.enum(['day', 'week', 'month'])
    })).query(...),

    profitLoss: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), year: z.number().int() })).query(...),
    balanceSheet: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), asOf: z.string().datetime() })).query(...),
    taxSummary: adminProcedure.input(z.object({ organizationId: z.string().uuid(), year: z.number().int() })).query(...),
  }),
});
```

---

### REPO 5: Remix — Healthcare Patient Portal

**Name:** `enterprise-remix-healthcare`
**Stack:** Remix v2 + TypeScript + Zod + session-based auth (NOT JWT) + Prisma + SQLite
**Auth:** Session cookies (remix sessions), HIPAA-conscious patterns, MFA stub
**Domain:** Healthcare — Patients, Appointments, Medical Records, Prescriptions, Billing

#### This Repo Tests: Session Cookie Auth (not Bearer token)

```typescript
// Auth is session-based — not JWT
// Login sets a secure HTTP-only cookie: patient_session
// SmokeForge must:
//   1. Detect session-cookie auth type (not bearer_jwt)
//   2. Generate Playwright tests that handle cookie-based auth
//   3. Use page.context().addCookies() or form submission to get session

// Critical difference from JWT:
// NO "Authorization: Bearer <token>" header
// Instead: Cookie: patient_session=<encrypted_session_id>

// This tests SmokeForge's auth-type detection accuracy
```

#### Remix Route Structure

```
app/routes/
  _index.tsx                              ← / (landing, public)
  auth.login.tsx                          ← /auth/login (action: POST credentials)
  auth.logout.tsx                         ← /auth/logout (action: POST, clears session)
  auth.register.tsx                       ← /auth/register (action: POST)
  auth.mfa.tsx                            ← /auth/mfa (action: POST, verify MFA code)

  dashboard.tsx                           ← /dashboard (auth-gated layout)
  dashboard._index.tsx                    ← /dashboard (index, redirects to appointments)

  patients._index.tsx                     ← /patients (admin only, patient list)
  patients.$patientId.tsx                 ← /patients/:patientId (patient detail)
  patients.$patientId.edit.tsx            ← edit patient profile
  patients.$patientId.records.tsx         ← medical records list
  patients.$patientId.records.$recordId.tsx ← single record view

  appointments._index.tsx                 ← /appointments (list — loader)
  appointments.new.tsx                    ← /appointments/new (action: POST)
  appointments.$appointmentId.tsx         ← appointment detail + reschedule action
  appointments.$appointmentId.cancel.tsx  ← cancel appointment action

  prescriptions._index.tsx               ← /prescriptions
  prescriptions.$prescriptionId.tsx      ← prescription detail
  prescriptions.$prescriptionId.refill.tsx ← request refill action

  billing._index.tsx                      ← /billing (list invoices)
  billing.$invoiceId.tsx                  ← invoice detail
  billing.$invoiceId.pay.tsx              ← payment action

  api.appointments.availability.tsx       ← /api/appointments/availability (resource route, GET)
  api.patients.search.tsx                ← /api/patients/search (resource route, GET, admin)
  api.upload.tsx                          ← /api/upload (resource route, POST, file upload)
```

---

### REPO 6: Monorepo — Enterprise SaaS Platform

**Name:** `enterprise-monorepo-platform`
**Stack:** Turborepo + NestJS API + Next.js Web + Shared Zod schemas
**Auth:** SSO via SAML2 stub + JWT for API, NextAuth for web
**Domain:** Multi-app platform — covers BOTH backend NestJS API and frontend Next.js

#### This Repo Tests: Monorepo Detection + Cross-Package Schema Sharing

```
enterprise-monorepo-platform/
├── turbo.json
├── pnpm-workspace.yaml
├── packages/
│   └── shared/
│       └── schemas/
│           └── index.ts        ← All Zod schemas shared between apps
│           (SmokeForge must find these even though they're not in apps/)
├── apps/
│   ├── api/                    ← NestJS app (port 4000)
│   │   ├── src/
│   │   │   ├── auth/           ← SAML2 SSO + JWT fallback
│   │   │   ├── organizations/  ← Multi-tenant
│   │   │   ├── users/
│   │   │   ├── billing/        ← Stripe webhook endpoints
│   │   │   └── reports/
│   │   └── package.json
│   └── web/                    ← Next.js 14 (port 3000)
│       ├── app/
│       │   ├── api/            ← BFF (Backend for Frontend) routes
│       │   ├── (auth)/
│       │   ├── (dashboard)/
│       │   └── (admin)/
│       └── package.json
```

#### SSO Auth Pattern This Repo Tests

```typescript
// SAML2 SSO flow (stubbed but structurally correct):
// 1. GET /api/auth/sso/initiate?organizationId=xxx
//    → Returns SAML assertion URL (redirect to IdP)
// 2. POST /api/auth/sso/callback
//    → Receives SAML assertion, creates JWT session
//    → body: { SAMLResponse, RelayState }
// 3. All subsequent API calls: Authorization: Bearer <jwt>

// SmokeForge validation:
// Must detect the SSO initiation endpoint
// Must detect the callback endpoint
// Must generate a test that:
//   a. Calls /auth/sso/initiate to understand the flow
//   b. Uses credentials login as fallback
//      (POST /api/auth/login with email+password → JWT)
//   c. Uses that JWT for subsequent test calls

// This tests: "When app has SSO, does SmokeForge
// find the fallback credentials endpoint and use it?"
```

---

## SECTION 3 — AUTH PATTERN MATRIX

Every auth type must be represented in at least one enterprise repo.

| Auth Type | Repo | Detection Signal | Test Generation Challenge |
|---|---|---|---|
| JWT Bearer | express-hr | `Authorization: Bearer` header | Standard — baseline |
| Passport JWT | nestjs-ecommerce | `JwtStrategy`, `@UseGuards(JwtAuthGuard)` | Guard decorator extraction |
| NextAuth credentials | nextjs-saas | `getServerSession()`, `getToken()` | Session cookie, not Bearer |
| NextAuth Google OAuth | nextjs-saas | `Provider: GoogleProvider` | SmokeForge generates credentials fallback |
| Session cookie | remix-healthcare | `getSession(request.headers.get('Cookie'))` | Cookie-based auth in Playwright |
| better-auth | trpc-finance | `betterAuth({})` | Newer library, detect from usage |
| SSO/SAML stub | monorepo-platform | `/auth/sso/initiate` pattern | Detect SSO + fallback to credentials |
| API Key (header) | nestjs-ecommerce webhooks | `x-webhook-secret` header | Different auth per endpoint group |
| Role-based JWT | express-hr | `requireRole(['admin'])` middleware | Multiple test credentials needed |
| Multi-tenant JWT | monorepo-platform | `organizationId` in JWT payload | Tenant-scoped test data |

---

## SECTION 4 — VALIDATION FRAMEWORK

This is the engine that measures SmokeForge's accuracy against every enterprise repo.

### 4.1 Validation Architecture

```
VALIDATION PIPELINE:

Input:
  ├── Enterprise Repo (source code)
  └── VALIDATION_MANIFEST.json (ground truth)

Step 1: Run SmokeForge analyze → TestBlueprint JSON
Step 2: EXTRACTION VALIDATOR → compare Blueprint vs Manifest
  ├── Endpoint coverage check
  ├── Method accuracy check
  ├── Path accuracy check
  ├── Schema field accuracy check
  ├── Auth detection accuracy check
  └── Locator quality check

Step 3: Run SmokeForge generate → Playwright + Postman files

Step 4: OUTPUT STRUCTURE VALIDATOR → check generated file structure
  ├── TypeScript compilation check
  ├── Auth flow presence check
  ├── All endpoint domains covered check
  └── Request body completeness check

Step 5: Start enterprise app + seed database

Step 6: EXECUTION VALIDATOR → run generated tests against live app
  ├── Auth tests pass
  ├── All GET requests return 200
  ├── All POST/PUT/PATCH requests return 2xx with correct body
  ├── Role-restricted endpoints return 403 for wrong role
  └── Endpoint coverage measurement

Output:
  └── ValidationReport.json (per-repo accuracy scores)
```

---

## SECTION 5 — ENDPOINT ACCURACY VALIDATOR

```typescript
// test/validation/endpoint-validator.ts

export interface EndpointValidationResult {
  repoName: string;
  totalExpected: number;           // from VALIDATION_MANIFEST.json
  totalFound: number;              // from SmokeForge TestBlueprint
  matched: MatchedEndpoint[];
  missing: ManifestEndpoint[];     // in manifest but not in blueprint
  extra: ExtractedEndpoint[];      // in blueprint but not in manifest (hallucinations)
  metrics: {
    recall: number;                // matched / totalExpected
    precision: number;             // matched / totalFound
    methodAccuracy: number;        // % of matched where method is correct
    pathAccuracy: number;          // % of matched where path is correct
    authAccuracy: number;          // % where authRequired matches manifest
    roleAccuracy: number;          // % where required roles match
  };
}

export function validateEndpoints(
  manifest: ValidationManifest,
  blueprint: TestBlueprint
): EndpointValidationResult {
  const matched: MatchedEndpoint[] = [];
  const missing: ManifestEndpoint[] = [];
  const extra: ExtractedEndpoint[] = [...blueprint.endpoints];

  for (const expected of manifest.endpoints) {
    // Match by: normalized method + normalized path
    const found = blueprint.endpoints.find(ep =>
      ep.method === expected.method &&
      normalizePath(ep.path) === normalizePath(expected.path)
    );

    if (found) {
      matched.push({ expected, found, discrepancies: findDiscrepancies(expected, found) });
      extra.splice(extra.indexOf(found), 1);
    } else {
      missing.push(expected);
    }
  }

  return {
    repoName: manifest.repo,
    totalExpected: manifest.endpoints.length,
    totalFound: blueprint.endpoints.length,
    matched,
    missing,
    extra,
    metrics: calculateMetrics(matched, missing, extra, manifest.endpoints)
  };
}

function normalizePath(path: string): string {
  // Normalize param names: /users/:userId === /users/:id === /users/:user_id
  // Only structure matters, not param names
  return path.replace(/:[a-zA-Z_]+/g, ':param').replace(/\{[a-zA-Z_]+\}/g, ':param');
}

function findDiscrepancies(
  expected: ManifestEndpoint,
  found: ExtractedEndpoint
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  if (expected.authRequired !== found.authRequired) {
    discrepancies.push({
      field: 'authRequired',
      expected: expected.authRequired,
      actual: found.authRequired,
      severity: 'HIGH'  // Auth wrong = test will fail in execution
    });
  }

  if (expected.requiredRoles && !rolesMatch(expected.requiredRoles, found.roles)) {
    discrepancies.push({
      field: 'roles',
      expected: expected.requiredRoles,
      actual: found.roles,
      severity: 'MEDIUM'
    });
  }

  return discrepancies;
}
```

---

## SECTION 6 — REQUEST BODY ACCURACY VALIDATOR

This is the most important validator. A wrong request body means the generated Postman request and Playwright test will send bad data, get a 422 from the server, and fail silently or with a confusing error.

```typescript
// test/validation/body-validator.ts

export interface BodyValidationResult {
  endpointId: string;
  method: string;
  path: string;
  expectedFields: ManifestField[];
  extractedFields: BodyField[];
  fieldResults: FieldResult[];
  metrics: {
    fieldRecall: number;          // % of required fields found
    fieldPrecision: number;       // % of found fields that are correct
    typeAccuracy: number;         // % of fields with correct type
    validatorAccuracy: number;    // % with correct validators (min, max, email, etc.)
    requiredAccuracy: number;     // % with correct required/optional status
    exampleQuality: number;       // % with useful (non-null) example values
  };
  criticalErrors: string[];       // Type wrong, required field missing, etc.
}

export function validateRequestBody(
  manifest: ManifestEndpoint,
  blueprint: ExtractedEndpoint
): BodyValidationResult {
  const expectedFields = manifest.requestBody?.fields ?? [];
  const extractedFields = blueprint.requestBody?.fields ?? [];

  const fieldResults: FieldResult[] = [];

  for (const expected of expectedFields) {
    const found = extractedFields.find(f => f.name === expected.name);

    if (!found) {
      fieldResults.push({
        fieldName: expected.name,
        status: 'MISSING',
        severity: expected.required ? 'CRITICAL' : 'WARNING',
        // If required field is missing, POST request will fail with 422
        message: `Required field "${expected.name}" not extracted`
      });
      continue;
    }

    const issues: string[] = [];

    // Type check
    if (!typeCompatible(expected.type, found.type)) {
      issues.push(`Type mismatch: expected "${expected.type}", got "${found.type}"`);
    }

    // Format check (email, uuid, date-time)
    if (expected.format && !found.validators.includes(expected.format)) {
      issues.push(`Missing format validator: ${expected.format}`);
    }

    // Required/optional check
    if (expected.required !== found.required) {
      issues.push(`Required mismatch: expected required=${expected.required}, got ${found.required}`);
    }

    // Enum values check
    if (expected.type === 'enum' && expected.values) {
      const foundEnum = found.validators.find(v => v.startsWith('enum('));
      if (!foundEnum || !enumValuesMatch(expected.values, foundEnum)) {
        issues.push(`Enum values mismatch: expected [${expected.values}]`);
      }
    }

    // Min/max check
    if (expected.minLength && !found.validators.find(v => v.includes(`min(${expected.minLength})`))) {
      issues.push(`Missing minLength(${expected.minLength}) validator`);
    }

    fieldResults.push({
      fieldName: expected.name,
      status: issues.length === 0 ? 'CORRECT' : 'INCORRECT',
      severity: issues.length > 0 ? 'MEDIUM' : 'OK',
      issues
    });
  }

  // Check for hallucinated fields (fields in blueprint not in manifest)
  const hallucinatedFields = extractedFields.filter(
    f => !expectedFields.find(e => e.name === f.name)
  );

  const criticalErrors = fieldResults
    .filter(r => r.severity === 'CRITICAL')
    .map(r => r.message);

  return {
    endpointId: manifest.id,
    method: manifest.method,
    path: manifest.path,
    expectedFields,
    extractedFields,
    fieldResults,
    metrics: calculateBodyMetrics(fieldResults, expectedFields, extractedFields, hallucinatedFields),
    criticalErrors
  };
}
```

---

## SECTION 7 — AUTH FLOW VALIDATOR

```typescript
// test/validation/auth-validator.ts

// This validator checks TWO things:
// 1. Did SmokeForge correctly identify the auth type and login endpoint?
// 2. Do the generated Playwright/Postman auth tests actually work?

export interface AuthValidationResult {
  repoName: string;
  expectedAuthType: string;
  detectedAuthType: string;
  authTypeCorrect: boolean;

  loginEndpointFound: boolean;
  loginEndpointCorrect: boolean;     // method + path correct
  tokenFieldCorrect: boolean;        // correct response field for token

  // Execution results
  loginTestPasses: boolean;          // actual POST to login returns 200
  tokenExtracted: boolean;           // token successfully extracted from response
  protectedEndpointAccessible: boolean;  // protected GET works with extracted token
  unauthorizedReturns401: boolean;  // no-token request returns 401

  // Role-based auth
  roleTests: RoleTestResult[];       // one per role in manifest
}

export interface RoleTestResult {
  role: string;
  loginSuccess: boolean;
  restrictedEndpointStatus: number;  // expected 403
  allowedEndpointStatus: number;     // expected 200
  correct: boolean;
}

// EXECUTION: actually run HTTP requests against the live app
export async function validateAuthExecution(
  manifest: ValidationManifest,
  baseUrl: string
): Promise<AuthValidationResult> {

  // Step 1: Test login endpoint works
  const loginResponse = await fetch(`${baseUrl}${manifest.auth.loginEndpoint.replace('POST ', '')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: manifest.auth.roles.admin.email,
      password: manifest.auth.roles.admin.password
    })
  });

  const loginBody = await loginResponse.json();
  const token = getNestedValue(loginBody, manifest.auth.tokenResponsePath);

  // Step 2: Test protected endpoint with token
  const protectedResponse = await fetch(`${baseUrl}/api/v1/employees`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // Step 3: Test protected endpoint WITHOUT token
  const unauthorizedResponse = await fetch(`${baseUrl}/api/v1/employees`);

  // Step 4: Test role-based access for each role
  const roleTests = await validateRoles(manifest, baseUrl);

  return {
    loginTestPasses: loginResponse.status === 200,
    tokenExtracted: !!token,
    protectedEndpointAccessible: protectedResponse.status === 200,
    unauthorizedReturns401: unauthorizedResponse.status === 401,
    roleTests,
    // ...other fields
  };
}

async function validateRoles(
  manifest: ValidationManifest,
  baseUrl: string
): Promise<RoleTestResult[]> {
  const results: RoleTestResult[] = [];

  for (const [roleName, credentials] of Object.entries(manifest.auth.roles)) {
    // Login as this role
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    const { accessToken } = await loginRes.json();

    // Try a role-restricted endpoint (admin only)
    const restrictedRes = await fetch(`${baseUrl}/api/v1/admin/audit-logs`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    // Try a role-allowed endpoint
    const allowedRes = await fetch(`${baseUrl}/api/v1/employees`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    const expectedStatus = roleName === 'admin' ? 200 : 403;
    results.push({
      role: roleName,
      loginSuccess: loginRes.status === 200,
      restrictedEndpointStatus: restrictedRes.status,
      allowedEndpointStatus: allowedRes.status,
      correct: restrictedRes.status === expectedStatus
    });
  }

  return results;
}
```

---

## SECTION 8 — UI LOCATOR ACCURACY VALIDATOR

```typescript
// test/validation/locator-validator.ts

// For each page in the manifest, validate that:
// 1. SmokeForge found the locator
// 2. The Playwright locator strategy is correct
// 3. The locator actually resolves in a running browser

import { chromium, Browser, Page } from 'playwright';

export interface LocatorValidationResult {
  pageRoute: string;
  expectedLocators: ManifestLocator[];
  extractedLocators: ExtractedLocator[];
  locatorResults: LocatorResult[];
  metrics: {
    recall: number;              // % of expected locators found
    strategyCorrectness: number; // % using correct priority strategy
    executionPassRate: number;   // % that actually resolve in browser
  };
}

export interface LocatorResult {
  name: string;
  expectedStrategy: string;
  actualStrategy: string;
  expectedCode: string;
  actualCode: string;
  strategyCorrect: boolean;
  resolvedInBrowser: boolean;   // did page.locator(code).count() > 0 ?
  isVisible: boolean;           // was it visible (not just present)?
  severity: 'OK' | 'WRONG_STRATEGY' | 'NOT_FOUND' | 'NOT_VISIBLE';
}

export async function validateLocatorsExecution(
  pageRoute: string,
  manifestLocators: ManifestLocator[],
  extractedLocators: ExtractedLocator[],
  baseUrl: string
): Promise<LocatorValidationResult> {
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  // Navigate to the page (with auth if needed)
  await page.goto(`${baseUrl}${pageRoute}`);
  await page.waitForLoadState('networkidle');

  const locatorResults: LocatorResult[] = [];

  for (const expected of manifestLocators) {
    const extracted = extractedLocators.find(l => l.name === expected.name);

    if (!extracted) {
      locatorResults.push({
        name: expected.name,
        severity: 'NOT_FOUND',
        resolvedInBrowser: false,
        isVisible: false,
        strategyCorrect: false,
        // ... other fields
      });
      continue;
    }

    // Check if locator actually resolves in browser
    let resolvedInBrowser = false;
    let isVisible = false;

    try {
      // Evaluate the playwright code string dynamically
      // e.g., extracted.playwrightCode = "page.getByRole('button', { name: 'Login' })"
      const count = await evalLocator(page, extracted.playwrightCode);
      resolvedInBrowser = count > 0;
      if (resolvedInBrowser) {
        isVisible = await evalLocatorVisible(page, extracted.playwrightCode);
      }
    } catch (err) {
      resolvedInBrowser = false;
    }

    locatorResults.push({
      name: expected.name,
      expectedStrategy: expected.expectedStrategy,
      actualStrategy: extracted.strategy,
      expectedCode: expected.expectedCode,
      actualCode: extracted.playwrightCode,
      strategyCorrect: extracted.strategy === expected.expectedStrategy,
      resolvedInBrowser,
      isVisible,
      severity: !resolvedInBrowser ? 'NOT_FOUND' :
                !isVisible ? 'NOT_VISIBLE' :
                extracted.strategy !== expected.expectedStrategy ? 'WRONG_STRATEGY' : 'OK'
    });
  }

  await browser.close();
  return buildLocatorResult(pageRoute, manifestLocators, extractedLocators, locatorResults);
}
```

---

## SECTION 9 — END-TO-END VALIDATION PIPELINE

This is the orchestrator that runs all validators against all repos.

```typescript
// test/validation/pipeline.ts

export interface RepoValidationReport {
  repoName: string;
  framework: string;
  timestamp: string;
  duration: number;

  extraction: {
    endpointRecall: number;
    endpointPrecision: number;
    bodyFieldRecall: number;
    bodyTypeAccuracy: number;
    authTypeCorrect: boolean;
    locatorRecall: number;
    locatorExecutionRate: number;
  };

  generation: {
    compilationPasses: boolean;
    authTestPresent: boolean;
    allDomainsHaveTests: boolean;
    requestBodiesComplete: boolean;   // no TODO placeholders in bodies
  };

  execution: {
    authFlowPasses: boolean;
    getEndpointPassRate: number;      // % of GET @smoke tests that pass
    postEndpointPassRate: number;     // % of POST @smoke tests that pass
    roleTestsPass: boolean;           // role-restricted tests correct
    overallPassRate: number;
    endpointCoverageRate: number;     // % of manifest endpoints with a passing test
  };

  criticalFailures: string[];         // anything that would make the tool unusable
  warnings: string[];
  passed: boolean;                    // overall: meets acceptance criteria?
}

export async function runFullValidation(
  repoConfig: EnterpriseRepoConfig
): Promise<RepoValidationReport> {
  const startTime = Date.now();
  const criticalFailures: string[] = [];
  const warnings: string[] = [];

  // ── Step 1: Run SmokeForge analyze ──────────────────────────────────────
  const blueprint = await runSmokeForgeAnalyze(repoConfig.path);
  const manifest = loadManifest(repoConfig.manifestPath);

  // ── Step 2: Validate extraction ──────────────────────────────────────────
  const endpointValidation = validateEndpoints(manifest, blueprint);
  const bodyValidation = validateAllRequestBodies(manifest, blueprint);
  const authValidation = validateAuthDetection(manifest, blueprint);
  const locatorValidation = validateLocators(manifest, blueprint);

  if (endpointValidation.metrics.recall < 0.80) {
    criticalFailures.push(`Endpoint recall too low: ${endpointValidation.metrics.recall}`);
  }
  if (bodyValidation.criticalErrors.length > 0) {
    criticalFailures.push(...bodyValidation.criticalErrors);
  }
  if (!authValidation.authTypeCorrect) {
    criticalFailures.push(`Auth type wrong: expected ${manifest.auth.type}, got ${authValidation.detectedAuthType}`);
  }

  // ── Step 3: Run SmokeForge generate ─────────────────────────────────────
  const outputDir = `/tmp/smokeforge-validation/${repoConfig.name}`;
  await runSmokeForgeGenerate(repoConfig.path, outputDir, repoConfig.baseUrl);

  // ── Step 4: Validate generated output structure ──────────────────────────
  const compilationPasses = await validateTypeScriptCompilation(outputDir);
  const authTestPresent = checkAuthTestPresent(outputDir, manifest);
  const bodiesComplete = checkRequestBodiesComplete(outputDir, manifest);

  if (!compilationPasses) {
    criticalFailures.push('Generated Playwright tests fail TypeScript compilation');
  }
  if (!authTestPresent) {
    criticalFailures.push('No auth/login test generated');
  }

  // ── Step 5: Start app and seed ───────────────────────────────────────────
  const appProcess = await startApp(repoConfig);
  await seedDatabase(repoConfig);
  await waitForHealth(repoConfig.baseUrl);

  // ── Step 6: Execute generated tests ──────────────────────────────────────
  const executionResults = await runGeneratedTests(outputDir, repoConfig.baseUrl, manifest);
  const authExecution = await validateAuthExecution(manifest, repoConfig.baseUrl);
  const locatorExecution = await validateLocatorsExecution(/* ... */);

  await appProcess.kill();

  // ── Step 7: Build report ──────────────────────────────────────────────────
  return {
    repoName: repoConfig.name,
    framework: repoConfig.framework,
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    extraction: {
      endpointRecall: endpointValidation.metrics.recall,
      endpointPrecision: endpointValidation.metrics.precision,
      bodyFieldRecall: bodyValidation.metrics.fieldRecall,
      bodyTypeAccuracy: bodyValidation.metrics.typeAccuracy,
      authTypeCorrect: authValidation.authTypeCorrect,
      locatorRecall: locatorValidation.metrics.recall,
      locatorExecutionRate: locatorExecution.metrics.executionPassRate,
    },
    generation: {
      compilationPasses,
      authTestPresent,
      allDomainsHaveTests: checkAllDomainsCovered(outputDir, manifest),
      requestBodiesComplete: bodiesComplete,
    },
    execution: {
      authFlowPasses: authExecution.loginTestPasses && authExecution.tokenExtracted,
      getEndpointPassRate: executionResults.getPassRate,
      postEndpointPassRate: executionResults.postPassRate,
      roleTestsPass: authExecution.roleTests.every(r => r.correct),
      overallPassRate: executionResults.overallPassRate,
      endpointCoverageRate: executionResults.coverageRate,
    },
    criticalFailures,
    warnings,
    passed: criticalFailures.length === 0
  };
}
```

---

## SECTION 10 — ACCEPTANCE CRITERIA PER CATEGORY

These are the gates. If SmokeForge does not meet these for a repo, that framework is NOT production-ready.

### Extraction Accuracy

| Metric | Minimum | Target | Critical Threshold |
|---|---|---|---|
| Endpoint Recall | 80% | 90% | < 70% = FAIL |
| Endpoint Precision | 90% | 98% | < 80% = FAIL |
| Body Field Recall (required fields) | 85% | 95% | < 75% = FAIL |
| Body Type Accuracy | 85% | 92% | < 80% = FAIL |
| Body Validator Accuracy | 75% | 88% | < 65% = FAIL |
| Auth Type Correct | 100% | 100% | Any wrong = FAIL |
| Login Endpoint Found | 100% | 100% | Not found = FAIL |
| Token Field Correct | 100% | 100% | Wrong = FAIL |
| Locator Recall | 75% | 88% | < 65% = FAIL |
| Locator Resolves in Browser | 80% | 92% | < 70% = FAIL |

### Generated Test Quality

| Check | Requirement |
|---|---|
| TypeScript compilation | Must pass with zero errors |
| Auth test present | Must have login test as first test |
| Auth test executes | Login test must return 200 |
| Token extracted | Token from login response is used in subsequent tests |
| All domains covered | Each API domain has at least one test |
| POST bodies complete | No `{}` or empty body on POST requests |
| Role tests present | If roles detected, tests exist for each role |
| No hardcoded URLs | All URLs use `process.env.BASE_URL` |
| No hardcoded credentials | All credentials use env vars |

### Execution Pass Rates

| Metric | Minimum | Target |
|---|---|---|
| Auth flow (login → token → protected request) | 100% | 100% |
| GET endpoint pass rate | 85% | 95% |
| POST endpoint pass rate | 80% | 90% |
| PUT/PATCH endpoint pass rate | 75% | 88% |
| DELETE endpoint pass rate | 75% | 88% |
| Role-restricted access (403 for wrong role) | 90% | 100% |
| Overall @smoke test pass rate | 80% | 90% |
| Endpoint coverage rate | 75% | 88% |

### Auth-Specific Acceptance Criteria

| Auth Type | Criteria |
|---|---|
| JWT Bearer | Login test extracts token, all subsequent tests use `Authorization: Bearer {token}` |
| Session Cookie | Login via form submission, cookie stored in context, subsequent tests include cookie |
| NextAuth | Credentials login via `/api/auth/callback/credentials`, session cookie used |
| SSO | Fallback to credentials login, SAML flow documented in test comments |
| API Key | Webhook tests include correct header (`x-webhook-secret: {value}`) |
| Role-based | Separate `beforeAll` login per role, correct credentials per role |

---

## SECTION 11 — IMPLEMENTATION ORDER

Build and validate in this order. Do not skip. Each repo validates a new capability.

```
PHASE 1 — Baseline Validation (Week 1-2)
  1. Build enterprise-express-hr repo
  2. Write VALIDATION_MANIFEST.json (45 endpoints, full schemas)
  3. Build endpoint-validator.ts
  4. Build body-validator.ts
  5. Run SmokeForge against it
  6. Fix extraction bugs until acceptance criteria met
  7. Build auth-validator.ts
  8. Run auth validation
  → Gate: Must achieve 90% endpoint recall before proceeding

PHASE 2 — NestJS + Decorator Auth (Week 3)
  1. Build enterprise-nestjs-ecommerce repo
  2. Write manifest (52 endpoints, class-validator DTOs)
  3. Run full validation pipeline
  4. Fix NestJS-specific extraction bugs
  → Gate: Auth type detection must be 100% for all roles

PHASE 3 — Full Stack + SSO Auth (Week 4)
  1. Build enterprise-nextjs-saas repo
  2. Write manifest (48 endpoints + 12 pages)
  3. Build locator-validator.ts
  4. Run locator validation (browser-based)
  5. Fix locator extraction issues
  → Gate: Login → protected page flow must work end-to-end

PHASE 4 — tRPC + Non-Standard Auth (Week 5)
  1. Build enterprise-trpc-finance repo
  2. Validate tRPC → HTTP path mapping
  3. Validate better-auth session detection
  → Gate: All tRPC procedures map to correct HTTP paths

PHASE 5 — Session Auth + Remix (Week 6)
  1. Build enterprise-remix-healthcare repo
  2. Validate session cookie auth (not Bearer)
  3. Validate Remix action method detection
  → Gate: Session cookie auth generates correct Playwright cookie setup

PHASE 6 — Monorepo + SSO (Week 7)
  1. Build enterprise-monorepo-platform repo
  2. Validate cross-package schema discovery
  3. Validate SSO detection + fallback
  → Gate: Schemas from packages/shared are extracted correctly

PHASE 7 — Validation Dashboard (Week 8)
  1. Build validation pipeline orchestrator
  2. Run all 6 repos through full pipeline
  3. Generate comparison report across all frameworks
  4. Document remaining gaps and confidence scores
  → Gate: All repos meet minimum acceptance criteria
```

---

## APPENDIX — VALIDATION_MANIFEST.json Full Schema

```typescript
// The TypeScript interface for every VALIDATION_MANIFEST.json

interface ValidationManifest {
  repo: string;
  framework: string;
  version: string;
  baseUrl: string;
  startCommand: string;          // "node dist/server.js"
  seedCommand: string;           // "pnpm seed"
  healthEndpoint: string;        // "GET /health"
  port: number;

  auth: {
    type: AuthType;
    loginEndpoint: string;       // "POST /api/v1/auth/login"
    credentialsFields: { email: string; password: string };
    tokenResponsePath: string;   // "accessToken" or "data.token"
    tokenHeaderName: string;     // "Authorization"
    tokenHeaderFormat: string;   // "Bearer {token}" or "{token}"
    refreshEndpoint: string | null;
    authCookieName: string | null;
    roles: Record<string, { email: string; password: string }>;
    publicEndpoints: string[];   // paths that DON'T need auth
  };

  endpoints: ManifestEndpoint[];
  pages: ManifestPage[];

  seedData: {
    adminUserId: string;
    regularUserId: string;
    sampleResourceIds: Record<string, string>; // "departmentId": "uuid..."
  };
}

interface ManifestEndpoint {
  id: string;
  method: string;
  path: string;
  authRequired: boolean;
  minRole: string | null;
  requiredRoles: string[] | null;
  pathParams: ManifestParam[];
  queryParams: ManifestParam[];
  requestBody: { fields: ManifestField[] } | null;
  expectedResponse: {
    status: number;
    bodyContains: string[];
  };
  roleAccessMatrix: Record<string, { expectedStatus: number }> | null;
}

interface ManifestField {
  name: string;
  type: string;
  format?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];     // for enums
  example: unknown;      // concrete example value
}

interface ManifestPage {
  route: string;
  title: string;
  authRequired: boolean;
  locators: ManifestLocator[];
  formFlows: ManifestFormFlow[];
}

interface ManifestLocator {
  name: string;
  expectedStrategy: 'testId' | 'role' | 'label' | 'placeholder' | 'css';
  expectedCode: string;          // exact Playwright code expected
  isInteractive: boolean;
  isVisible: boolean;            // should be visible on initial load
}
```
