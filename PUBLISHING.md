# Publishing Guide

This guide covers how to publish this private npm package to different registries.

## Option 1: Private npm Registry (Requires Paid Account)

### Setup

1. **Create an npm account** (if you don't have one)
2. **Upgrade to a paid plan** (required for private packages on public npm)

### Publishing

```bash
# Login
npm login

# Publish (package.json already has "private": true)
npm publish --access restricted
```

### Installing in Projects

```bash
npm install @codedesign/vite-live-edit-plugin
```

---

## Option 2: GitHub Packages (Recommended for Free Private Packages)

### Setup

1. **Create a GitHub Personal Access Token**:
   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Create token with `write:packages` and `read:packages` permissions

2. **Create `.npmrc` file** in the package directory:
   ```
   @codedesign:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
   ```

   Or set it globally:
   ```bash
   echo "@codedesign:registry=https://npm.pkg.github.com" >> ~/.npmrc
   echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
   ```

3. **Update package.json** (if needed):
   ```json
   {
     "repository": {
       "type": "git",
       "url": "https://github.com/YOUR_USERNAME/codedesign-live-edit-plugin.git"
     },
     "publishConfig": {
       "registry": "https://npm.pkg.github.com"
     }
   }
   ```

### Publishing

```bash
# Login
npm login --registry=https://npm.pkg.github.com --scope=@codedesign

# Publish
npm publish
```

### Installing in Projects

1. **Create `.npmrc` in your project** (or set globally):
   ```
   @codedesign:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
   ```

2. **Install**:
   ```bash
   npm install @codedesign/vite-live-edit-plugin
   ```

---

## Option 3: Private Git Repository (Easiest for Internal Use)

### Setup

1. **Create a private Git repository**
2. **Push your code**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/codedesign-live-edit-plugin.git
   git push -u origin main
   ```

### Publishing (Versioning)

```bash
# Tag a version
git tag v1.0.0
git push origin v1.0.0

# For updates
git tag v1.0.1
git push origin v1.0.1
```

### Installing in Projects

```bash
# Install from Git
npm install git+https://github.com/YOUR_USERNAME/codedesign-live-edit-plugin.git

# Or with a specific version
npm install git+https://github.com/YOUR_USERNAME/codedesign-live-edit-plugin.git#v1.0.0

# Or with SSH (if you have SSH keys set up)
npm install git+ssh://git@github.com:YOUR_USERNAME/codedesign-live-edit-plugin.git
```

### Using SSH with GitHub

If you use SSH for GitHub:

1. **Add SSH key to GitHub** (if not already done)
2. **Install**:
   ```bash
   npm install git+ssh://git@github.com:YOUR_USERNAME/codedesign-live-edit-plugin.git
   ```

---

## Option 4: Local File System (Development Only)

### Setup

```bash
# In the package directory
npm link
```

### Installing in Projects

```bash
# In your project directory
npm link @codedesign/vite-live-edit-plugin
```

This creates a symlink, so changes to the plugin are immediately available.

---

## Version Management

### Semantic Versioning

- **Major** (1.0.0): Breaking changes
- **Minor** (0.1.0): New features, backward compatible
- **Patch** (0.0.1): Bug fixes, backward compatible

### Updating Version

```bash
# Update version in package.json
npm version patch  # or minor, or major

# This automatically:
# 1. Updates package.json version
# 2. Creates a git tag
# 3. Commits the change

# Then publish
npm publish  # or git push --tags for Git repos
```

---

## Best Practices

1. **Always test locally first**:
   ```bash
   npm link
   # Test in your project
   ```

2. **Use semantic versioning** consistently

3. **Keep CHANGELOG.md** (optional but recommended)

4. **Tag releases** in Git for easy reference

5. **Document breaking changes** in README

---

## Troubleshooting

### "Package not found" Error

- Check your `.npmrc` configuration
- Verify authentication token
- Ensure package name matches exactly

### "Access denied" Error

- Check repository permissions (for GitHub Packages)
- Verify npm account has access (for private npm)
- Ensure authentication token has correct scopes

### "Private package" Error

- Remove `"private": true` from package.json (if using Git)
- Or ensure you have a paid npm account
- Or use GitHub Packages (free for private packages)
