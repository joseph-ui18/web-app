const { User, CustomerProfile } = require('../models');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET; // set this in your .env file
const JWT_EXPIRES_IN = '7d';
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/;

/* ============================================================
   REGISTER (role always defaults to 'user')
   ============================================================ */
exports.register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required' });
        }
        if (!STRONG_PASSWORD_REGEX.test(password)) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and contain an uppercase letter, a lowercase letter, a number, and a special character.'
            });
        }

        const existing = await User.findOne({ where: { email } });
        if (existing) {
            return res.status(409).json({ message: 'Email is already registered' });
        }

        // password gets hashed automatically by the beforeCreate hook in user.js
        const user = await User.create({ name, email, password, role: 'user' });

        // create an empty profile shell for them
        await CustomerProfile.create({ user_id: user.id });

        // Generate JWT token
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        // Save token to database for validation and revocation
        await user.update({
            token,
            token_issued_at: new Date()
        });

        return res.status(201).json({
            message: 'Registered successfully',
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        });
    } catch (err) {
        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: err.errors[0].message });
        }
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong during registration' });
    }
};

/* ============================================================
   LOGIN
   ============================================================ */
exports.login = async (req, res) => {
    try {
        const { name, password } = req.body;
        const email = req.body.email?.trim().toLowerCase();

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        // defaultScope hides password, so explicitly include it here
        const user = await User.scope('withPassword').findOne({ where: { email } });

        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (!user.is_active) {
            return res.status(403).json({ message: 'This account has been deactivated. Contact support.' });
        }

        if (user.deleted_at) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const isMatch = await user.checkPassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        // Generate JWT token
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        // Save token to database for validation and revocation
        await user.update({
            token,
            token_issued_at: new Date()
        });

        return res.status(200).json({
            message: 'Logged in successfully',
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong during login' });
    }
};

/* ============================================================
   LOGOUT (revoke token)
   ============================================================ */
exports.logout = async (req, res) => {
    try {
        // Clear token from database to revoke it
        await User.update(
            { token: null, token_issued_at: null },
            { where: { id: req.user.id } }
        );

        return res.status(200).json({
            message: 'Logged out successfully'
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong during logout' });
    }
};

/* ============================================================
   GET MY PROFILE (logged-in user)
   ============================================================ */
exports.getMe = async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, {
            include: [{ model: CustomerProfile }]
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).json({ user });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong' });
    }
};

/* ============================================================
   UPDATE MY PROFILE (name on User, phone/image on CustomerProfile)
   ============================================================ */
exports.updateMe = async (req, res) => {
    try {
        const { name, phone, image_path } = req.body;

        const user = await User.findByPk(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (name) await user.update({ name });

        const profile = await CustomerProfile.findOne({ where: { user_id: user.id } });
        if (profile && (phone !== undefined || image_path !== undefined)) {
            await profile.update({
                ...(phone !== undefined && { phone }),
                ...(image_path !== undefined && { image_path })
            });
        }

        return res.status(200).json({ message: 'Profile updated' });
    } catch (err) {
        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: err.errors[0].message });
        }
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong updating profile' });
    }
};

/* ============================================================
   ADMIN: LIST ALL USERS (optionally include soft-deleted)
   ============================================================ */
exports.listUsers = async (req, res) => {
    try {
        const includeDeleted = req.query.include_deleted === 'true';

        const users = await User.findAll({
            paranoid: !includeDeleted // paranoid:false means "show deleted too"
        });

        return res.status(200).json({ users });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong fetching users' });
    }
};

/* ============================================================
   ADMIN: ACTIVATE / DEACTIVATE
   ============================================================ */
exports.setActiveStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body; // true or false

        const user = await User.findByPk(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.role === 'admin') {
            return res.status(403).json({ message: 'Admin accounts cannot be deactivated' });
        }

        // Use static update to avoid the beforeUpdate hook running on an instance
        // loaded without the password attribute (default scope excludes it).
        await User.update({ is_active }, { where: { id } });

        return res.status(200).json({
            message: `User ${is_active ? 'activated' : 'deactivated'} successfully`
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong updating status' });
    }
};

/* ============================================================
   ADMIN: UPDATE ROLE
   ============================================================ */
exports.setRole = async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!['admin', 'user'].includes(role)) {
            return res.status(400).json({ message: 'Role must be admin or user' });
        }

        const user = await User.findByPk(id, { paranoid: false });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.deleted_at) {
            return res.status(409).json({ message: 'Restore this user before changing the role' });
        }

        if (String(user.id) === String(req.user.id)) {
            return res.status(403).json({ message: 'You cannot change your own role' });
        }

        // Use static update to avoid the beforeUpdate hook operating on an instance
        // that was loaded under the default scope (password excluded). An instance.update()
        // on such an object can cause Sequelize to write NULL over the hashed password in
        // certain versions. The static form only touches the columns explicitly listed.
        await User.update({ role }, { where: { id } });

        return res.status(200).json({
            message: 'User role updated successfully',
            user: { id: user.id, name: user.name, email: user.email, role, is_active: user.is_active }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong updating role' });
    }
};

/* ============================================================
   ADMIN: SOFT DELETE
   ============================================================ */
exports.deleteUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findByPk(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.role === 'admin') {
            return res.status(403).json({ message: 'Admin accounts cannot be deleted' });
        }

        await user.destroy(); // soft delete — sets deleted_at
        return res.status(200).json({ message: 'User deleted' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong deleting user' });
    }
};

/* ============================================================
   ADMIN: RESTORE
   ============================================================ */
exports.restoreUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findByPk(id, { paranoid: false }); // must look past the default scope to find deleted rows
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        await user.restore();
        return res.status(200).json({ message: 'User restored' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Something went wrong restoring user' });
    }
};