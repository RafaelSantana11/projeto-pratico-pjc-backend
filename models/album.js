const Sequelize = require('sequelize')

class Album extends Sequelize.Model {
    static init(sequelize, Sequelize) {
        return super.init(
            {   
                name: Sequelize.STRING,
                publicationYear: Sequelize.STRING,
            },
            {
                underscored: true,
                sequelize,
            }
        )
    }

    static associate(models) {
        this.belongsTo(models.Artist)
        this.hasMany(models.AlbumMedia)
    }
}

module.exports = Album
